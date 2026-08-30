/**
 * What a deploy does to a game in progress.
 *
 * Publishing a worker restarts its durable object and closes every socket with it.
 * The board must not change, the words already found must stay, and the score must
 * find its way back onto the leaderboard.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { roundAt } from "../src/game/schedule";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { seedReturningPlayer } from "./pagesetup";

const PORT = 8794;
const URL = `http://127.0.0.1:${PORT}/`;
let worker: ChildProcess | null = null;
let browser: Browser;
const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));

function startWorker() {
  worker = spawn("npx", ["wrangler", "dev", "--port", String(PORT), "--local"], {
    stdio: "ignore",
  });
}

async function waitForWorker() {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev never came up");
}

async function stopWorker() {
  if (!worker) return;
  const dying = worker;
  worker = null;
  dying.kill("SIGTERM");
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(URL);
    } catch {
      return; // refusing connections, so it is down
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  dying.kill("SIGKILL");
}

beforeAll(async () => {
  browser = await chromium.launch();
  startWorker();
  await waitForWorker();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await stopWorker();
});

test("restarting the room mid-round keeps the board, the words and the score", async () => {
  for (;;) {
    const { phase, remainingMs } = roundAt(Date.now());
    // Enough of the round left to restart inside it.
    if (phase === "playing" && remainingMs > 90_000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page, "ada");
  await page.goto(URL);
  await page.waitForSelector('[data-room="live"]', { timeout: 30_000 });
  await page.waitForSelector(".tile");

  const tiles = () => page.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()));
  const before = await tiles();
  const solution = [...solveBoard(before, trie)].sort((a, b) => b.length - a.length);
  const picks = solution.slice(0, 3);
  for (const w of picks) {
    await page.locator(".entry__input").fill(w);
    await page.locator(".entry__input").press("Enter");
  }
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 3);

  // The deploy.
  await stopWorker();
  await page.waitForSelector('[data-room="reconnecting"]', { timeout: 15_000 });

  // Mid-outage the board is still the one being played, and so are the words.
  expect(await tiles()).toEqual(before);
  expect(await page.locator(".guesses li").count()).toBe(3);
  expect(await page.locator(".entry__input").isDisabled()).toBe(false);

  startWorker();
  await waitForWorker();

  await page.waitForSelector('[data-room="live"]', { timeout: 40_000 });
  // The restarted room deals the round it already had, not a fresh one.
  expect(await tiles()).toEqual(before);
  expect(await page.locator(".guesses li").count()).toBe(3);

  // And the words find their way back onto the leaderboard.
  await page.waitForFunction(
    () => document.querySelectorAll(".ladder__row").length > 0,
    undefined,
    {
      timeout: 30_000,
    },
  );
  const score = Number(await page.locator(".ladder__score").first().textContent());
  const expected = picks.reduce(
    (n, w) => n + (w.length >= 8 ? 11 : [0, 0, 0, 0, 1, 2, 3, 5][w.length]),
    0,
  );
  expect(score, `expected the round's ${expected} points back`).toBe(expected);

  await page.close();
}, 240_000);
