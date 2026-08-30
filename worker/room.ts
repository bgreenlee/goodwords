import { rollBoardWith } from "../src/game/dice";
import { scoreWord } from "../src/game/scoring";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { PLAY_MS, ROUND_MS, roundAt } from "../src/game/schedule";
import {
  PLAYERS_SHOWN,
  type ClientMessage,
  type LeaderRow,
  type ServerMessage,
} from "../src/net/protocol";

/** A player types a handful of words a second at most; well above human speed. */
const MAX_WORDS_PER_SECOND = 10;
const LEADERBOARD_INTERVAL_MS = 750;
const MAX_NAME = 16;

type Player = {
  id: string;
  name: string;
  score: number;
  words: Set<string>;
  rejected: number;
  stamps: number[];
};

type Live = { round: number; board: string[]; solution: Set<string> };

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
  private trie: Trie | null = null;
  private loading: Promise<Trie> | null = null;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBroadcast = 0;
  private nextId = 1;

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

    const player: Player = {
      id: `p${this.nextId++}`,
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
      this.players.delete(server);
      this.scheduleLeaderboard();
    };
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    // The board goes out as soon as the dictionary is ready.
    this.ctx.waitUntil(this.sendBoard(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The dictionary is a static asset, fetched once per object lifetime. */
  private async dictionary(): Promise<Trie> {
    if (this.trie) return this.trie;
    if (!this.loading) {
      this.loading = this.env.ASSETS.fetch(new Request("https://assets.local/data/words.txt"))
        .then((r) => r.text())
        .then((text) => {
          this.trie = new Trie(text.split("\n").filter(Boolean));
          return this.trie;
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
    const trie = await this.dictionary();
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
    return { round, board, solution: solveBoard(board, trie) };
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
            this.live = live;
            for (const player of this.players.values()) {
              player.score = 0;
              player.words.clear();
              player.rejected = 0;
            }
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
  }

  private async sendBoard(ws: WebSocket): Promise<void> {
    this.sendBoardFor(ws, await this.current());
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
      player.name = String(msg.name ?? "").slice(0, MAX_NAME).trim();
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
    // The server keeps its own solution; a client's claim is never taken on trust.
    if (!live.solution.has(word)) {
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
    for (const [ws, player] of this.players) {
      this.send(ws, {
        t: "lb",
        round,
        top,
        players,
        rank: rankOf.get(player.id) ?? 0,
        score: player.score,
      });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      this.players.delete(ws);
    }
  }
}
