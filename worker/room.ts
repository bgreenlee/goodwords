import { CELL_COUNT, rollBoardWith } from "../src/game/dice";
import { pickBonus, type BonusCandidate, type BonusWord } from "../src/game/bonus";
import { BONUS_MULTIPLIER, UNIQUE_MULTIPLIER, scoreWord } from "../src/game/scoring";
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
  type Tally,
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

type Live = { round: number; board: string[]; bonus: BonusWord | null };

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
  private bonusList: BonusCandidate[] | null = null;
  private loadingBonus: Promise<BonusCandidate[]> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcast = 0;
  /**
   * Health of the fan-out. A worker freezes Date.now() during synchronous work, so
   * a broadcast cannot time itself; what it can see is how far apart consecutive
   * broadcasts land. When that stretches past the interval the room is behind.
   */
  private broadcasts = 0;
  private worstGapMs = 0;
  private lastGapMs = 0;
  private nextId = 1;
  /** Restarting resets the counter, so ids carry something that does not repeat. */
  private readonly instance = Math.random().toString(36).slice(2, 8);
  private schemaReady = false;
  private dailyCache: { round: number; top: DailyRow[] } | null = null;
  private knownNames = new Map<string, string>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith("/stats")) {
      return Response.json({
        players: this.players.size,
        round: this.live?.round ?? null,
        broadcasts: this.broadcasts,
        lastGapMs: this.lastGapMs,
        worstGapMs: this.worstGapMs,
        intervalMs: LEADERBOARD_INTERVAL_MS,
      });
    }
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
      this.onMessage(server, player, event.data).catch((err) => {
        // Log it and carry on. Tearing the socket down turns one bad message into
        // a lost game, and the player can still see the board and keep playing.
        console.error("could not handle a message", err);
      });
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

  /** Bonus-word candidates, longest first. Fetched once per object lifetime. */
  private async bonusCandidates(): Promise<BonusCandidate[]> {
    if (this.bonusList) return this.bonusList;
    if (!this.loadingBonus) {
      this.loadingBonus = this.env.ASSETS.fetch(new Request("https://assets.local/data/bonus.json"))
        .then((r) => {
          if (!r.ok) throw new Error(`bonus list unavailable: ${r.status}`);
          return r.json() as Promise<BonusCandidate[]>;
        })
        .then((list) => {
          this.bonusList = list;
          return list;
        })
        .catch((err) => {
          this.loadingBonus = null;
          throw err;
        });
    }
    return this.loadingBonus;
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
    // Storage can refuse — a quota, most likely. Losing the written-down board
    // costs a re-roll if the object restarts mid-round; failing here would cost
    // the game entirely, which is a far worse trade.
    try {
      const saved = await this.ctx.storage.get<{ round: number; board: string[] }>(LIVE_KEY);
      if (saved && saved.round === round && saved.board?.length === CELL_COUNT) {
        return { round, board: saved.board, bonus: await this.bonusFor(saved.board) };
      }
    } catch (err) {
      console.error("could not read the round in play", err);
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
    try {
      await this.ctx.storage.put(LIVE_KEY, { round, board });
    } catch (err) {
      console.error("could not write down the round in play", err);
    }
    return { round, board, bonus: await this.bonusFor(board) };
  }

  /**
   * Close out a round. A word only you found is worth double, which can only be
   * known once everyone's words are in — so it is settled here rather than as the
   * word is played. With one player there is nobody to have missed anything.
   */
  private settle(finished: Live): void {
    const counts = new Map<string, number>();
    for (const player of this.players.values()) {
      for (const word of player.words) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const contested = this.players.size > 1;

    for (const [ws, player] of this.players) {
      const unique = contested ? [...player.words].filter((w) => counts.get(w) === 1) : [];
      const uniqueBonus = unique.reduce((n, w) => n + scoreWord(w) * (UNIQUE_MULTIPLIER - 1), 0);
      player.score += uniqueBonus;
      const tally: Tally = {
        round: finished.round,
        unique,
        uniqueBonus,
        bonusWord: finished.bonus?.word ?? null,
        gotBonus: finished.bonus ? player.words.has(finished.bonus.word) : false,
        score: player.score,
      };
      this.send(ws, { t: "tally", ...tally });
    }
  }

  /** A board that can spell nothing worth naming simply has no bonus that round. */
  private async bonusFor(board: string[]): Promise<BonusWord | null> {
    try {
      return pickBonus(board, await this.bonusCandidates());
    } catch (err) {
      console.error("could not choose a bonus word", err);
      return null;
    }
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
            if (finished) this.settle(finished);
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
    try {
      const at = (Math.floor(Date.now() / ROUND_MS) + 1) * ROUND_MS;
      const existing = await this.ctx.storage.getAlarm();
      if (existing !== at) await this.ctx.storage.setAlarm(at);
    } catch (err) {
      // Losing the alarm costs a prompt board at the boundary, not the game: the
      // next message rolls the round anyway.
      console.error("could not arm the round alarm", err);
    }
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
    // The day's standings are a nicety. Storage can refuse — a quota, a bad row —
    // and when it does the player should still get a board and a game.
    try {
      this.send(ws, { t: "daily", top: this.dailyTop(), since: Date.now() - DAY_MS });
    } catch (err) {
      console.error("daily standings unavailable", err);
    }
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
      bonus: live.bonus
        ? {
            partOfSpeech: live.bonus.partOfSpeech,
            gloss: live.bonus.gloss,
            length: live.bonus.word.length,
          }
        : null,
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

    const isBonus = live.bonus?.word === word;
    const points = scoreWord(word) * (isBonus ? BONUS_MULTIPLIER : 1);
    player.words.add(word);
    player.score += points;
    this.send(ws, {
      t: "ok",
      w: word,
      points,
      score: player.score,
      ...(isBonus ? { bonus: true as const } : {}),
    });
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
    const at = Date.now();
    if (this.lastBroadcast > 0) {
      this.lastGapMs = at - this.lastBroadcast;
      if (this.lastGapMs > this.worstGapMs) this.worstGapMs = this.lastGapMs;
    }
    this.broadcasts++;
    this.lastBroadcast = at;
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
    // One write per connection becomes a lot of writes during a reconnect storm,
    // and the row only changes when the name does.
    if (this.knownNames.get(player.key) === player.name) return;
    this.knownNames.set(player.key, player.name);
    try {
      this.rememberOrThrow(player);
    } catch (err) {
      // A display name is not worth a disconnection.
      console.error("could not store a player name", err);
    }
  }

  private rememberOrThrow(player: Player): void {
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
    // A finished round is worth keeping but never worth an exception on a path
    // that also has to close a socket or start the next round.
    try {
      this.recordOrThrow(player, round);
    } catch (err) {
      console.error("could not file a finished round", err);
    }
  }

  private recordOrThrow(player: Player, round: number): void {
    // Something new is being filed, so the cached standings are out of date. The
    // next reader pays for one scan; every reader after that is free.
    this.dailyCache = null;
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
    // The standings only move when a round ends, so scanning per connection was
    // pure waste — and on the free tier it is waste with a daily budget attached.
    const round = this.live?.round ?? 0;
    if (this.dailyCache?.round === round) return this.dailyCache.top;

    const sql = this.schema();
    const since = Date.now() - DAY_MS;
    sql.exec(`DELETE FROM results WHERE at < ?`, since);
    const top = sql
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
    this.dailyCache = { round, top };
    return top;
  }

  private broadcastDaily(): void {
    let top: DailyRow[];
    try {
      top = this.dailyTop();
    } catch (err) {
      console.error("daily standings unavailable", err);
      return;
    }
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
