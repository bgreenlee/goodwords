import { CELL_COUNT, rollBoardWith } from "../src/game/dice";
import { scoreWord } from "../src/game/scoring";
import { findPath } from "../src/game/solver";
import { WordIndex } from "../src/game/wordindex";
import { PLAY_MS, ROUND_MS, roundAt } from "../src/game/schedule";
import {
  DAY_MS,
  PLAYERS_SHOWN,
  type ClientMessage,
  type DailyRow,
  type LeaderRow,
  type ServerMessage,
} from "../src/net/protocol";

/** A player types a handful of words a second at most; well above human speed. */
const MAX_WORDS_PER_SECOND = 10;
const LEADERBOARD_INTERVAL_MS = 750;
const MAX_NAME = 16;
const MIN_WORD = 4;
/** Where the round in play is written down, so a restart resumes it. */
const LIVE_KEY = "live";

type Player = {
  /** This connection. Changes on every reconnect. */
  id: string;
  /** This browser, if it offered one. Stable across reconnects and rounds. */
  key: string;
  name: string;
  score: number;
  words: Set<string>;
  rejected: number;
  stamps: number[];
};

type Live = { round: number; board: string[] };

export interface Env {
  ASSETS: Fetcher;
  ROOM: DurableObjectNamespace;
}

/**
 * The room every player is in.
 *
 * Rounds are globally scheduled, so all players occupy the same room at the same
 * time; there is nothing to gain from a room per round, and rotating rooms would
 * make every client reconnect at once on each boundary. This object lives across
 * rounds and pushes a fresh board instead. To grow past what one object can
 * broadcast, shard players across several rooms and add a per-round aggregator
 * that merges their top scores.
 */
export class GameRoom {
  private ctx: DurableObjectState;
  private env: Env;
  private players = new Map<WebSocket, Player>();
  private live: Live | null = null;
  private rolling: { round: number; ready: Promise<Live> } | null = null;
  private words: WordIndex | null = null;
  private loading: Promise<WordIndex> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcast = 0;
  private nextId = 1;
  /** Restarting resets the counter, so ids carry something that does not repeat. */
  private readonly instance = Math.random().toString(36).slice(2, 8);
  private schemaReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();

    const connection = `${this.instance}-${this.nextId++}`;
    const player: Player = {
      id: connection,
      key: connection,
      name: "",
      score: 0,
      words: new Set(),
      rejected: 0,
      stamps: [],
    };
    this.players.set(server, player);

    server.addEventListener("message", (event) => {
      this.onMessage(server, player, event.data).catch(() => server.close(1011, "error"));
    });
    const drop = () => {
      const leaving = this.players.get(server);
      if (leaving && this.live) this.record(leaving, this.live.round);
      this.players.delete(server);
      this.scheduleLeaderboard();
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    // The board goes out as soon as the dictionary is ready. A failure here used to
    // disappear into waitUntil, leaving the player connected to a room that never
    // dealt; tell them instead.
    this.ctx.waitUntil(
      this.sendBoard(server).catch((err) => {
        console.error("could not deal a board", err);
        try {
          server.close(1011, "could not start the game");
        } catch {
          /* already gone */
        }
      }),
    );
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The dictionary is a static asset, fetched once per object lifetime. */
  private async dictionary(): Promise<WordIndex> {
    if (this.words) return this.words;
    if (!this.loading) {
      this.loading = this.env.ASSETS.fetch(new Request("https://assets.local/data/words.txt"))
        .then((r) => {
          if (!r.ok) throw new Error(`word list unavailable: ${r.status}`);
          return r.text();
        })
        .then((text) => {
          this.words = new WordIndex(text);
          return this.words;
        })
        .catch((err) => {
          // Let the next connection retry rather than wedging the room for good.
          this.loading = null;
          throw err;
        });
    }
    return this.loading;
  }

  /**
   * Roll a board nobody can precompute. The solo game derives its board from the
   * round number, which is fine when there is no leaderboard to game, but here the
   * board must not exist anywhere until the round begins.
   */
  private async startRound(round: number): Promise<Live> {
    await this.dictionary();

    // A deploy restarts this object, and so does eviction. Rolling a fresh board
    // then would swap the board out from under everyone mid-round, so the round's
    // board is written down and reused if this round has already begun.
    const saved = await this.ctx.storage.get<{ round: number; board: string[] }>(LIVE_KEY);
    if (saved && saved.round === round && saved.board?.length === CELL_COUNT) {
      return { round, board: saved.board };
    }

    const bytes = new Uint32Array(64);
    crypto.getRandomValues(bytes);
    let i = 0;
    const next = () => {
      if (i >= bytes.length) {
        crypto.getRandomValues(bytes);
        i = 0;
      }
      return bytes[i++] / 4294967296;
    };
    const board = rollBoardWith(next);
    await this.ctx.storage.put(LIVE_KEY, { round, board });
    return { round, board };
  }

  private async current(): Promise<Live> {
    const { round } = roundAt(Date.now());
    if (this.live?.round !== round) {
      // Roll once per round, however many callers arrive together. In practice the
      // object's input gate and a cached dictionary make `startRound` effectively
      // synchronous after the first round, so nothing interleaves — but a board
      // being dealt exactly once should not rest on that.
      if (this.rolling?.round !== round) {
        const ready = this.startRound(round).then(
          (live) => {
            const finished = this.live;
            for (const player of this.players.values()) {
              if (finished) this.record(player, finished.round);
              player.score = 0;
              player.words.clear();
              player.rejected = 0;
            }
            this.live = live;
            return live;
          },
          (err) => {
            if (this.rolling?.round === round) this.rolling = null;
            throw err;
          },
        );
        this.rolling = { round, ready };
      }
      await this.rolling.ready;
    }
    await this.armAlarm();
    return this.live!;
  }

  /** Wake at the next round boundary so a new board goes out without a client asking. */
  private async armAlarm(): Promise<void> {
    if (this.players.size === 0) return;
    const at = (Math.floor(Date.now() / ROUND_MS) + 1) * ROUND_MS;
    const existing = await this.ctx.storage.getAlarm();
    if (existing !== at) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    if (this.players.size === 0) return;
    const live = await this.current();
    for (const ws of this.players.keys()) this.sendBoardFor(ws, live);
    this.broadcastLeaderboard();
    // The window only moves when a round ends, so this is the moment to resend it.
    this.broadcastDaily();
  }

  private async sendBoard(ws: WebSocket): Promise<void> {
    this.sendBoardFor(ws, await this.current());
    this.send(ws, { t: "daily", top: this.dailyTop(), since: Date.now() - DAY_MS });
  }

  private sendBoardFor(ws: WebSocket, live: Live): void {
    const player = this.players.get(ws);
    if (!player) return;
    const now = Date.now();
    const start = live.round * ROUND_MS;
    this.send(ws, {
      t: "board",
      round: live.round,
      board: live.board,
      now,
      playEndsAt: start + PLAY_MS,
      roundEndsAt: start + ROUND_MS,
      you: player.id,
      players: this.players.size,
    });
  }

  private async onMessage(ws: WebSocket, player: Player, raw: unknown): Promise<void> {
    if (typeof raw !== "string" || raw.length > 512) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.t === "hello" || msg.t === "name") {
      player.name = String(msg.name ?? "")
        .slice(0, MAX_NAME)
        .trim();
      // A browser that offers an id keeps one identity across reconnects and
      // rounds; one that does not is only ever this connection.
      if (msg.t === "hello" && typeof msg.id === "string" && /^[\w-]{8,64}$/.test(msg.id)) {
        player.key = msg.id;
      }
      this.remember(player);
      this.scheduleLeaderboard();
      return;
    }
    if (msg.t !== "word") return;

    const live = await this.current();
    const word = String(msg.w ?? "").toLowerCase();
    const now = Date.now();

    // Typing faster than a person can is the cheapest cheat to catch.
    player.stamps = player.stamps.filter((t) => now - t < 1000);
    if (player.stamps.length >= MAX_WORDS_PER_SECOND) {
      return this.send(ws, { t: "no", w: word, reason: "too fast" });
    }
    player.stamps.push(now);

    if (roundAt(now).phase !== "playing") {
      return this.send(ws, { t: "no", w: word, reason: "round over" });
    }
    if (player.words.has(word)) {
      return this.send(ws, { t: "no", w: word, reason: "already found" });
    }
    // A client's claim is never taken on trust: the word has to be a real word and
    // the board has to be able to spell it.
    if (word.length < MIN_WORD) {
      return this.send(ws, { t: "no", w: word, reason: "too short" });
    }
    if (!this.words!.has(word) || !findPath(live.board, word)) {
      player.rejected++;
      return this.send(ws, { t: "no", w: word, reason: "not on this board" });
    }

    player.words.add(word);
    player.score += scoreWord(word);
    this.send(ws, { t: "ok", w: word, points: scoreWord(word), score: player.score });
    this.scheduleLeaderboard();
  }

  /** Coalesce updates: one board-wide broadcast beats one per word found. */
  private scheduleLeaderboard(): void {
    if (this.broadcastTimer) return;
    const wait = Math.max(0, LEADERBOARD_INTERVAL_MS - (Date.now() - this.lastBroadcast));
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      this.broadcastLeaderboard();
    }, wait);
  }

  private broadcastLeaderboard(): void {
    this.lastBroadcast = Date.now();
    const round = this.live?.round ?? 0;
    const ranked = [...this.players.values()]
      .filter((p) => p.score > 0)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const top: LeaderRow[] = ranked.slice(0, PLAYERS_SHOWN).map((p) => ({
      id: p.id,
      name: p.name || "anonymous",
      score: p.score,
      words: p.words.size,
    }));
    const rankOf = new Map(ranked.map((p, i) => [p.id, i + 1]));
    const players = this.players.size;

    // Only rank and score differ between players, so the standings are serialised
    // once and each frame finished by hand. Going through send() would re-encode
    // the whole table for every socket, which is most of the work at scale.
    // The shape has to match the "lb" case of ServerMessage; the room tests read it.
    const shared = `{"t":"lb","round":${round},"players":${players},"top":${JSON.stringify(top)}`;
    for (const [ws, player] of this.players) {
      try {
        ws.send(`${shared},"rank":${rankOf.get(player.id) ?? 0},"score":${player.score}}`);
      } catch {
        this.players.delete(ws);
      }
    }
  }

  /**
   * A round's scores are worthless thirty seconds later, but a day of them is a
   * leaderboard. This is the only state that outlives a round, and it lives in the
   * object's own SQLite rather than a separate database.
   */
  private schema(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.schemaReady) {
      sql.exec(
        `CREATE TABLE IF NOT EXISTS players (
           id TEXT PRIMARY KEY, name TEXT NOT NULL, seen INTEGER NOT NULL
         )`,
      );
      sql.exec(
        `CREATE TABLE IF NOT EXISTS results (
           round INTEGER NOT NULL, player TEXT NOT NULL, score INTEGER NOT NULL,
           words INTEGER NOT NULL, at INTEGER NOT NULL,
           PRIMARY KEY (round, player)
         )`,
      );
      sql.exec(`CREATE INDEX IF NOT EXISTS results_at ON results (at)`);
      this.schemaReady = true;
    }
    return sql;
  }

  private remember(player: Player): void {
    this.schema().exec(
      `INSERT INTO players (id, name, seen) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, seen = excluded.seen`,
      player.key,
      player.name || "anonymous",
      Date.now(),
    );
  }

  /** File a finished round. Replaces on conflict, so recording twice is harmless. */
  private record(player: Player, round: number): void {
    if (player.score <= 0) return;
    this.remember(player);
    this.schema().exec(
      `INSERT OR REPLACE INTO results (round, player, score, words, at)
         VALUES (?, ?, ?, ?, ?)`,
      round,
      player.key,
      player.score,
      player.words.size,
      Date.now(),
    );
  }

  private dailyTop(): DailyRow[] {
    const sql = this.schema();
    const since = Date.now() - DAY_MS;
    sql.exec(`DELETE FROM results WHERE at < ?`, since);
    return sql
      .exec(
        `SELECT r.player AS id,
                COALESCE(p.name, 'anonymous') AS name,
                SUM(r.score) AS total,
                COUNT(*) AS rounds,
                MAX(r.score) AS best
           FROM results r LEFT JOIN players p ON p.id = r.player
          WHERE r.at >= ?
          GROUP BY r.player
          ORDER BY total DESC, best DESC
          LIMIT ?`,
        since,
        PLAYERS_SHOWN,
      )
      .toArray() as unknown as DailyRow[];
  }

  private broadcastDaily(): void {
    const top = this.dailyTop();
    const since = Date.now() - DAY_MS;
    for (const ws of this.players.keys()) this.send(ws, { t: "daily", top, since });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.players.delete(ws);
    }
  }
}
