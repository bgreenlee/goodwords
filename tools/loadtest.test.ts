/**
 * Load harness. Not a test — it reports numbers.
 *
 *   PLAYERS=500 npm run loadtest
 *   PLAYERS=2000 LOAD_URL=ws://127.0.0.1:8795 SECONDS=30 npm run loadtest
 *
 * Each virtual player holds a socket and submits real words off the dealt board at
 * roughly the pace of a fast human, which is what the room actually has to absorb.
 */
import { rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, test } from "vitest";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { roundAt } from "../src/game/schedule";
import type { ServerMessage } from "../src/net/protocol";

/** Durable object state for this suite alone, so runs cannot contaminate each other. */
const STATE = ".wrangler/state-load";
const PORT = Number(process.env.LOAD_PORT ?? 8795);
const HTTP = process.env.LOAD_HTTP ?? `http://127.0.0.1:${PORT}`;
const WS = process.env.LOAD_WS ?? `ws://127.0.0.1:${PORT}`;
const PLAYERS = Number(process.env.PLAYERS ?? 200);
const SECONDS = Number(process.env.SECONDS ?? 25);
/** A strong player finds a word every few seconds; this is deliberately brisk. */
const WORD_EVERY_MS = Number(process.env.WORD_EVERY_MS ?? 4000);
const OWN_WORKER = !process.env.LOAD_WS;

let worker: ChildProcess | null = null;

async function serving() {
  try {
    return (await fetch(HTTP, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  rmSync(STATE, { recursive: true, force: true });
  if (!OWN_WORKER) return;
  worker = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--local", "--persist-to", STATE],
    {
      stdio: "ignore",
      detached: true,
    },
  );
  for (let i = 0; i < 200; i++) {
    if (await serving()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev never came up");
}, 150_000);

afterAll(async () => {
  if (worker?.pid) {
    try {
      process.kill(-worker.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
});

const pct = (xs: number[], p: number) =>
  xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0;

test("load", async () => {
  // Words only score while a round is being played, so start one with room to run.
  for (;;) {
    const { phase, remainingMs } = roundAt(Date.now());
    if (phase === "playing" && remainingMs > (SECONDS + 20) * 1000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const trie = new Trie(words);

  const stats = {
    connected: 0,
    failed: 0,
    closedEarly: 0,
    boards: 0,
    sent: 0,
    ok: 0,
    rejected: 0,
    leaderboards: 0,
    latencies: [] as number[],
  };

  let solution: string[] = [];
  const sockets: WebSocket[] = [];
  const pending = new Map<string, number[]>();

  const start = Date.now();
  for (let i = 0; i < PLAYERS; i++) {
    const ws = new WebSocket(`${WS}/api/play`);
    sockets.push(ws);
    ws.addEventListener("open", () => {
      stats.connected++;
      ws.send(JSON.stringify({ t: "hello", name: `bot${i}`, id: `load-${i}-${start}` }));
    });
    ws.addEventListener("error", () => stats.failed++);
    ws.addEventListener("close", () => stats.closedEarly++);
    ws.addEventListener("message", (e) => {
      const raw = String(e.data);
      // Leaderboards are most of the traffic and the harness has nothing to do with
      // them. Parsing them all would make this measure the harness, not the room.
      if (raw.startsWith('{"t":"lb"')) {
        stats.leaderboards++;
        return;
      }
      const m = JSON.parse(raw) as ServerMessage;
      if (m.t === "board") {
        stats.boards++;
        if (solution.length === 0) solution = [...solveBoard(m.board, trie)];
      } else if (m.t === "ok" || m.t === "no") {
        const at = pending.get(m.w)?.shift();
        if (at !== undefined) stats.latencies.push(Date.now() - at);
        if (m.t === "ok") stats.ok++;
        else stats.rejected++;
      }
    });
    // Spread the arrivals; a thundering herd measures the ramp, not the room.
    if (i % 100 === 99) await new Promise((r) => setTimeout(r, 60));
  }

  // Let everyone land and be dealt a board.
  for (let i = 0; i < 100 && stats.boards < PLAYERS * 0.95; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const rampMs = Date.now() - start;

  const deadline = Date.now() + SECONDS * 1000;
  let turn = 0;
  while (Date.now() < deadline) {
    const phase = roundAt(Date.now()).phase;
    if (phase === "playing" && solution.length > 0) {
      for (const ws of sockets) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        const word = solution[turn % solution.length];
        turn++;
        const queue = pending.get(word) ?? [];
        queue.push(Date.now());
        pending.set(word, queue);
        try {
          ws.send(JSON.stringify({ t: "word", w: word }));
          stats.sent++;
        } catch {
          /* socket gone */
        }
      }
    }
    await new Promise((r) => setTimeout(r, WORD_EVERY_MS));
  }

  const elapsed = (Date.now() - start) / 1000;
  const open = sockets.filter((s) => s.readyState === WebSocket.OPEN).length;
  for (const s of sockets) s.close();

  console.log(`
players requested   ${PLAYERS}
connected           ${stats.connected}   (still open at end: ${open})
socket errors       ${stats.failed}
boards dealt        ${stats.boards}
ramp to all boards  ${rampMs} ms
words sent          ${stats.sent}
  accepted          ${stats.ok}
  refused           ${stats.rejected}
  no reply          ${stats.sent - stats.ok - stats.rejected}
word round trip     p50 ${pct(stats.latencies, 0.5)} ms   p95 ${pct(stats.latencies, 0.95)} ms   p99 ${pct(stats.latencies, 0.99)} ms   max ${Math.max(0, ...stats.latencies)} ms
leaderboards        ${stats.leaderboards} total, ${(stats.leaderboards / Math.max(1, open) / elapsed).toFixed(2)} per player per second
`);
}, 600_000);
