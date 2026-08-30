/**
 * Load to breaking point. Forks several client processes, because one Node process
 * saturates around two thousand sockets.
 *
 *   PLAYERS=10000 LOAD_WS=wss://… LOAD_HTTP=https://… npm run loadbig
 */
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { expect, test } from "vitest";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { roundAt } from "../src/game/schedule";
import type { ServerMessage } from "../src/net/protocol";

const WS = process.env.LOAD_WS ?? "ws://127.0.0.1:8795";
const HTTP = process.env.LOAD_HTTP ?? "http://127.0.0.1:8795";
const PLAYERS = Number(process.env.PLAYERS ?? 5000);
const SECONDS = Number(process.env.SECONDS ?? 15);
const WORD_EVERY_MS = Number(process.env.WORD_EVERY_MS ?? 4000);
/** Past roughly this many sockets a single process is the thing being measured. */
const PER_PROCESS = Number(process.env.PER_PROCESS ?? 1500);

const pct = (xs: number[], p: number) =>
  xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * p))] : 0;

async function stats() {
  try {
    const r = await fetch(`${HTTP}/api/stats`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

test("load to breaking point", async () => {
  for (;;) {
    const { phase, remainingMs } = roundAt(Date.now());
    if (phase === "playing" && remainingMs > (SECONDS + 45) * 1000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // One probe socket learns the board so every child can play real words.
  const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));
  const probe = new WebSocket(`${WS}/api/play`);
  const board = await new Promise<string[]>((resolve, reject) => {
    probe.addEventListener("message", (e) => {
      const m = JSON.parse(String(e.data)) as ServerMessage;
      if (m.t === "board") resolve(m.board);
    });
    probe.addEventListener("error", () => reject(new Error("probe failed")));
    setTimeout(() => reject(new Error("probe timed out")), 20_000);
  });
  const words = [...solveBoard(board, trie)].slice(0, 300);
  probe.close();
  expect(words.length).toBeGreaterThan(20);

  const shards = Math.min(cpus().length, Math.max(1, Math.ceil(PLAYERS / PER_PROCESS)));
  const per = Math.ceil(PLAYERS / shards);
  console.log(`\n${PLAYERS} players over ${shards} processes (${per} each), ${words.length} words`);

  const totals = {
    connected: 0,
    failed: 0,
    closed: 0,
    boards: 0,
    sent: 0,
    ok: 0,
    refused: 0,
    leaderboards: 0,
    stillOpen: 0,
  };
  let latencies: number[] = [];
  const closeCodes: Record<string, number> = {};
  const children: ChildProcess[] = [];
  const rampStart = Date.now();

  const finished = Promise.all(
    Array.from({ length: shards }, (_, k) => {
      const child = fork("tools/loadgen.mjs", [], {
        env: {
          ...process.env,
          WS,
          COUNT: String(per),
          OFFSET: String(k * per),
          WORD_EVERY_MS: String(WORD_EVERY_MS),
          DURATION_MS: String(SECONDS * 1000),
          WORDS: JSON.stringify(words),
          HANDSHAKE_BATCH: process.env.HANDSHAKE_BATCH ?? "200",
          HANDSHAKE_PAUSE_MS: process.env.HANDSHAKE_PAUSE_MS ?? "40",
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      children.push(child);
      return new Promise<void>((resolve) => {
        child.on(
          "message",
          (msg: { type: string; stats?: typeof totals & { latencies: number[] } }) => {
            if (msg.type === "done" && msg.stats) {
              for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
                totals[key] += (msg.stats as unknown as Record<string, number>)[key] ?? 0;
              }
              latencies = latencies.concat(msg.stats.latencies);
              const codes = (msg.stats as unknown as { closeCodes?: Record<string, number> })
                .closeCodes;
              for (const [code, n] of Object.entries(codes ?? {})) {
                closeCodes[code] = (closeCodes[code] ?? 0) + n;
              }
            }
          },
        );
        child.on("exit", () => resolve());
      });
    }),
  );

  // Watch the room's own view while the load is on.
  const samples: Array<Record<string, unknown>> = [];
  const watcher = setInterval(async () => {
    const s = await stats();
    if (s) samples.push(s);
  }, 3000);
  // worstGapMs on the object is worst-ever, not worst-this-run: the room outlives
  // a run. The sampled gaps are the honest per-run figure.

  await finished;
  clearInterval(watcher);
  const elapsed = (Date.now() - rampStart) / 1000;
  latencies.sort((a, b) => a - b);
  const peak = samples.reduce<Record<string, unknown> | null>(
    (best, s) => (!best || (s.players as number) > (best.players as number) ? s : best),
    null,
  );

  console.log(
    `
asked for           ${PLAYERS}
client connected    ${totals.connected}   (open at end: ${totals.stillOpen})
client errors       ${totals.failed}, closed early ${totals.closed}
boards dealt        ${totals.boards}
room saw at peak    ${peak ? peak.players : "n/a"} players
words sent          ${totals.sent}  accepted ${totals.ok}  refused ${totals.refused}  unanswered ${totals.sent - totals.ok - totals.refused}
round trip          p50 ${pct(latencies, 0.5)}ms  p95 ${pct(latencies, 0.95)}ms  p99 ${pct(latencies, 0.99)}ms  max ${latencies.at(-1) ?? 0}ms
fan-out gap         worst sampled this run ${Math.max(0, ...samples.map((x) => Number(x.lastGapMs) || 0))}ms against a 750ms target` +
      ` (object's worst ever: ${peak ? peak.worstGapMs : "?"}ms)
leaderboards        ${totals.leaderboards} in ${elapsed.toFixed(0)}s
close codes         ${
        Object.entries(closeCodes)
          .map(([c, n]) => `${c} x${n}`)
          .join("  ") || "none"
      }
`,
  );
}, 900_000);
