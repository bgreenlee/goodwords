import { spawn } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { scoreWord } from "../src/game/scoring";
import { roundAt } from "../src/game/schedule";
import { readFileSync } from "node:fs";
import type { ServerMessage } from "../src/net/protocol";

const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof spawn>;

const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));

/** A websocket wrapper that queues messages so tests can await them in order. */
class Client {
  ws: WebSocket;
  private queue: ServerMessage[] = [];
  private seen: ServerMessage[] = [];
  private wake: (() => void) | null = null;

  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/play`);
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data)) as ServerMessage;
      this.queue.push(msg);
      this.seen.push(msg);
      this.wake?.();
    });
  }

  open() {
    return new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error("websocket failed to open")));
    });
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  /** The next message of a given type; other messages stay queued. */
  async next<T extends ServerMessage["t"]>(
    t: T,
    timeoutMs = 8000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.queue.findIndex((m) => m.t === t);
      if (i >= 0) return this.queue.splice(i, 1)[0] as never;
      if (Date.now() > deadline) {
        // Say what did arrive, so a failure explains itself.
        throw new Error(`timed out waiting for "${t}"; saw ${JSON.stringify(this.seen.slice(-6))}`);
      }
      await new Promise<void>((res) => {
        this.wake = res;
        setTimeout(res, 100);
      });
      this.wake = null;
    }
  }
}

/**
 * The server scores against the real clock, so wait for a round with enough play
 * left to finish in. Without this the suite would fail during every break.
 */
async function waitForPlayTime(minMs = 25_000) {
  for (;;) {
    const { phase, remainingMs } = roundAt(Date.now());
    if (phase === "playing" && remainingMs > minMs) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(BASE);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev never came up");
}, 90_000);

afterAll(() => server?.kill());

test("players arriving together are dealt one board, not one each", async () => {
  // A cold room has no board yet. The connect path is serialised by the object's
  // input gate, so this does not by itself exercise the roll race — see
  // boundary.test.ts for that — but everyone joining must still see one board.
  const crowd = Array.from({ length: 8 }, () => new Client());
  await Promise.all(crowd.map((c) => c.open()));
  crowd.forEach((c, i) => c.send({ t: "hello", name: `p${i}` }));

  const dealt = await Promise.all(crowd.map((c) => c.next("board", 15_000)));
  const boards = new Set(dealt.map((d) => d.board.join("")));
  expect(boards.size, `${boards.size} different boards dealt to 8 players`).toBe(1);
  expect(new Set(dealt.map((d) => d.round)).size).toBe(1);
  // Every player gets a distinct identity.
  expect(new Set(dealt.map((d) => d.you)).size).toBe(8);

  for (const c of crowd) c.ws.close();
}, 60_000);

test("the room deals a board, scores real words, and rejects the rest", async () => {
  await waitForPlayTime();
  const a = new Client();
  await a.open();
  a.send({ t: "hello", name: "ada" });

  const dealt = await a.next("board");
  expect(dealt.board).toHaveLength(25);
  expect(dealt.round).toBeGreaterThan(0);
  // The server's clock is the authority; it should be close to ours.
  expect(Math.abs(dealt.now - Date.now())).toBeLessThan(10_000);
  expect(dealt.playEndsAt).toBeLessThan(dealt.roundEndsAt);

  const solution = [...solveBoard(dealt.board, trie)];
  expect(solution.length).toBeGreaterThan(20);

  const word = solution[0];
  a.send({ t: "word", w: word });
  const ok = await a.next("ok");
  expect(ok.w).toBe(word);
  expect(ok.points).toBe(scoreWord(word));
  expect(ok.score).toBe(scoreWord(word));

  // A word the board cannot spell must be refused however the client asks.
  a.send({ t: "word", w: "zzzzq" });
  expect((await a.next("no")).reason).toContain("not on this board");

  a.send({ t: "word", w: word });
  expect((await a.next("no")).reason).toContain("already found");

  // A second player sees the same board and both appear on the leaderboard.
  const b = new Client();
  await b.open();
  b.send({ t: "hello", name: "grace" });
  const dealtB = await b.next("board");
  expect(dealtB.board).toEqual(dealt.board);
  expect(dealtB.round).toBe(dealt.round);
  expect(dealtB.you).not.toBe(dealt.you);

  const other = solution.find((w) => w !== word && scoreWord(w) > scoreWord(word)) ?? solution[1];
  b.send({ t: "word", w: other });
  await b.next("ok");

  const board = await b.next("lb");
  expect(board.players).toBeGreaterThanOrEqual(2);
  const names = board.top.map((r) => r.name);
  expect(names).toContain("ada");
  expect(names).toContain("grace");
  // Ranking is by score, highest first.
  const scores = board.top.map((r) => r.score);
  expect([...scores].sort((x, y) => y - x)).toEqual(scores);

  a.ws.close();
  b.ws.close();
}, 90_000);

test("a flood of guesses is throttled rather than scored", async () => {
  await waitForPlayTime(10_000);
  const c = new Client();
  await c.open();
  c.send({ t: "hello", name: "bot" });
  const dealt = await c.next("board");
  const solution = [...solveBoard(dealt.board, trie)];
  expect(solution.length).toBeGreaterThan(25);

  // Paste 25 real words at once, which no person can type.
  for (const w of solution.slice(0, 25)) c.send({ t: "word", w });

  let accepted = 0;
  let throttled = 0;
  const deadline = Date.now() + 4000;
  while (accepted + throttled < 25 && Date.now() < deadline) {
    const msg = await Promise.race([
      c
        .next("ok", 1500)
        .then((m) => m as ServerMessage)
        .catch(() => null),
      c
        .next("no", 1500)
        .then((m) => m as ServerMessage)
        .catch(() => null),
    ]);
    if (!msg) break;
    if (msg.t === "ok") accepted++;
    else if (msg.t === "no" && msg.reason === "too fast") throttled++;
  }
  expect(throttled, `accepted ${accepted}, throttled ${throttled}`).toBeGreaterThan(0);
  c.ws.close();
}, 90_000);
