import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { solveBoard } from "../src/game/solver";
import { pickBonus, type BonusCandidate } from "../src/game/bonus";
import { Trie } from "../src/game/trie";
import { scoreWord } from "../src/game/scoring";
import { roundAt } from "../src/game/schedule";
import { readFileSync } from "node:fs";
import type { ServerMessage } from "../src/net/protocol";
import { randomUUID } from "node:crypto";

/** Durable object state for this suite alone, so runs cannot contaminate each other. */
const STATE = ".wrangler/state-room";
const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof spawn>;

const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));
const bonusList = JSON.parse(readFileSync("public/data/bonus.json", "utf8")) as BonusCandidate[];

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
  rmSync(STATE, { recursive: true, force: true });
  server = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--local", "--persist-to", STATE],
    {
      stdio: "ignore",
    },
  );
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

test("a day's standings outlive the connection that earned them", async () => {
  await waitForPlayTime(20_000);
  // A fresh id each run: the object keeps its SQLite between runs, as it should.
  const me = randomUUID();

  const first = new Client();
  await first.open();
  first.send({ t: "hello", name: "ada", id: me });
  const dealt = await first.next("board");
  const solution = [...solveBoard(dealt.board, trie)];

  const word = solution.reduce((a, b) => (scoreWord(b) > scoreWord(a) ? b : a));
  first.send({ t: "word", w: word });
  const ok = await first.next("ok");
  expect(ok.score).toBe(scoreWord(word));

  // Closing the tab must not throw the round away.
  first.ws.close();
  await new Promise((r) => setTimeout(r, 500));

  const again = new Client();
  await again.open();
  again.send({ t: "hello", name: "ada", id: me });
  await again.next("board");

  const day = await again.next("daily");
  const mine = day.top.find((row) => row.id === me);
  expect(mine, `no entry for ${me} in ${JSON.stringify(day.top)}`).toBeDefined();
  expect(mine!.name).toBe("ada");
  expect(mine!.total).toBe(scoreWord(word));
  expect(mine!.rounds).toBe(1);
  expect(mine!.best).toBe(scoreWord(word));

  // Standings are ordered by total, highest first.
  const totals = day.top.map((r) => r.total);
  expect([...totals].sort((a, b) => b - a)).toEqual(totals);
  expect(day.since).toBeLessThan(Date.now());

  again.ws.close();
}, 90_000);

test("a browser without an id still plays, and is not merged with anyone", async () => {
  await waitForPlayTime(15_000);
  const a = new Client();
  const b = new Client();
  await Promise.all([a.open(), b.open()]);
  // No id offered: the room falls back to the connection, which is unique.
  a.send({ t: "hello", name: "one" });
  b.send({ t: "hello", name: "two" });
  const [da, db] = await Promise.all([a.next("board"), b.next("board")]);
  expect(da.you).not.toBe(db.you);

  const solution = [...solveBoard(da.board, trie)];
  a.send({ t: "word", w: solution[0] });
  await a.next("ok");
  const lb = await a.next("lb");
  expect(lb.top.filter((r) => r.name === "one")).toHaveLength(1);

  a.ws.close();
  b.ws.close();
}, 90_000);

test("the round is named for a word, and the clue is its definition", async () => {
  await waitForPlayTime(20_000);
  const c = new Client();
  await c.open();
  c.send({ t: "hello", name: "hunter", id: randomUUID() });
  const dealt = await c.next("board");

  const expected = pickBonus(dealt.board, bonusList);
  if (!expected) {
    // Two boards in a hundred can spell nothing worth naming.
    expect(dealt.bonus).toBeNull();
    c.ws.close();
    return;
  }

  expect(dealt.bonus).not.toBeNull();
  expect(dealt.bonus!.length).toBe(expected.word.length);
  expect(dealt.bonus!.gloss).toBe(expected.gloss);
  // The clue is the definition. The word itself is the puzzle.
  expect(JSON.stringify(dealt.bonus)).not.toContain(expected.word);

  // An ordinary word is scored plainly.
  const plain = [...solveBoard(dealt.board, trie)].find(
    (w) => w !== expected.word && w.length === 4,
  )!;
  c.send({ t: "word", w: plain });
  const ordinary = await c.next("ok");
  expect(ordinary.points).toBe(scoreWord(plain));
  expect(ordinary.bonus).toBeUndefined();

  // The named word pays double and says so.
  c.send({ t: "word", w: expected.word });
  const hit = await c.next("ok");
  expect(hit.w).toBe(expected.word);
  expect(hit.bonus).toBe(true);
  expect(hit.points).toBe(scoreWord(expected.word) * 2);
  expect(hit.score).toBe(ordinary.points + hit.points);

  c.ws.close();
}, 90_000);
