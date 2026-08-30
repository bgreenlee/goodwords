/**
 * Crossing a real round boundary with players connected.
 *
 * This is the one path the rest of the suite cannot reach: boundaries arrive every
 * 210 seconds on the wall clock, and the interesting race is on the message path,
 * where several players submit words in the moment the room's board has gone stale.
 * It waits for a genuine boundary, so it is slow and lives outside `npm test`.
 * Run it with `npm run test:boundary`.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";
import { roundAt, ROUND_MS } from "../src/game/schedule";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import type { ServerMessage } from "../src/net/protocol";

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;
let server: ReturnType<typeof spawn>;
const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));

class Client {
  ws: WebSocket;
  boards: Extract<ServerMessage, { t: "board" }>[] = [];
  oks: Extract<ServerMessage, { t: "ok" }>[] = [];

  constructor() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/play`);
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.t === "board") this.boards.push(m);
      if (m.t === "ok") this.oks.push(m);
    });
  }
  open() {
    return new Promise<void>((res) => this.ws.addEventListener("open", () => res()));
  }
  send(msg: unknown) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

beforeAll(async () => {
  server = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: "ignore",
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev never came up");
}, 90_000);

afterAll(() => server?.kill());

test("everyone crosses a boundary onto the same new board", async () => {
  // Join while the current round still has a while to run, so the connection is
  // established well before the boundary we care about.
  for (;;) {
    const { phase, remainingMs } = roundAt(Date.now());
    if (phase === "break" && remainingMs > 6000) break;
    if (phase === "playing" && remainingMs < 4000) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const crowd = Array.from({ length: 6 }, () => new Client());
  await Promise.all(crowd.map((c) => c.open()));
  crowd.forEach((c, i) => c.send({ t: "hello", name: `p${i}` }));
  await new Promise((r) => setTimeout(r, 1500));

  const before = crowd.map((c) => c.boards.at(-1)!);
  expect(before.every(Boolean)).toBe(true);
  const startRound = before[0].round;
  expect(new Set(before.map((b) => b.board.join(""))).size).toBe(1);

  // Hammer the message path across the boundary: every client keeps submitting, so
  // several land in the window where the room's board has gone stale.
  const boundary = (startRound + 1) * ROUND_MS;
  const words = [...solveBoard(before[0].board, trie)].slice(0, 40);
  let i = 0;
  const pump = setInterval(() => {
    for (const c of crowd) c.send({ t: "word", w: words[i % words.length] ?? "abcd" });
    i++;
  }, 120);

  await new Promise((r) => setTimeout(r, Math.max(0, boundary - Date.now()) + 6000));
  clearInterval(pump);

  // Exactly one new board, and the same one for everybody.
  const after = crowd.map((c) => c.boards.filter((b) => b.round === startRound + 1));
  for (const [n, got] of after.entries()) {
    expect(
      got.length,
      `player ${n} received ${got.length} boards for the new round`,
    ).toBeGreaterThan(0);
    expect(
      new Set(got.map((b) => b.board.join(""))).size,
      `player ${n} saw conflicting boards`,
    ).toBe(1);
  }
  const distinct = new Set(after.map((got) => got[0].board.join("")));
  expect(distinct.size, `${distinct.size} different boards across 6 players`).toBe(1);
  expect(after[0][0].board).not.toEqual(before[0].board);

  for (const c of crowd) c.ws.close();
}, 300_000);
