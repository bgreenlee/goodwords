/**
 * What a deploy does to a game in progress.
 *
 * Publishing a worker restarts its durable object and closes every socket with it.
 * The board must not change, the words already found must stay, and the score must
 * find its way back onto the leaderboard.
 */
import { rmSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { roundAt } from "../src/game/schedule";
import { pickBonus, type BonusCandidate } from "../src/game/bonus";
import { BONUS_MULTIPLIER, scoreWord } from "../src/game/scoring";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { seedReturningPlayer } from "./pagesetup";

/** Durable object state for this suite alone, so runs cannot contaminate each other. */
const STATE = ".wrangler/state-restart";
const PORT = 8794;
const URL = `http://127.0.0.1:${PORT}/`;
let worker: ChildProcess | null = null;
let browser: Browser;
const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));
const bonusList = JSON.parse(readFileSync("public/data/bonus.json", "utf8")) as BonusCandidate[];

function startWorker() {
  // Its own process group: `npx` spawns node which spawns workerd, and signalling
  // only the wrapper leaves the server running — which looks, from the test's side,
  // exactly like a deploy that changed nothing.
  worker = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--local", "--persist-to", STATE],
    {
      stdio: "ignore",
      detached: true,
    },
  );
}

async function serving(): Promise<boolean> {
  try {
    return (await fetch(URL, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function waitForWorker() {
  for (let i = 0; i < 160; i++) {
    if (await serving()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev never came up");
}

async function stopWorker() {
  const dying = worker;
  worker = null;
  const pid = dying?.pid;
  if (!pid) return;

  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig); // negative pid: the whole group
    } catch {
      /* already gone */
    }
  };

  signal("SIGTERM");
  for (let i = 0; i < 60; i++) {
    if (!(await serving())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  signal("SIGKILL");
  for (let i = 0; i < 40; i++) {
    if (!(await serving())) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  // Say so here, rather than let it surface as a puzzling timeout further down.
  throw new Error(`worker on ${PORT} would not stop`);
}

beforeAll(async () => {
  rmSync(STATE, { recursive: true, force: true });
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

  // Ask the scoring rules rather than restating them: a copy of the table here
  // just goes stale the next time they change. The bonus word pays double, and
  // these are the longest words on the board, so it may well be among them.
  const bonus = pickBonus(before, bonusList);
  const expected = picks.reduce(
    (n, w) => n + scoreWord(w) * (w === bonus?.word ? BONUS_MULTIPLIER : 1),
    0,
  );

  // The words find their way back onto the leaderboard, but deliberately one at a
  // time — reading as soon as the first row appears catches the replay half done.
  await page
    .waitForFunction(
      (want) => Number(document.querySelector(".ladder__score")?.textContent) === want,
      expected,
      { timeout: 30_000 },
    )
    .catch(() => {
      /* fall through to the assertion, which reports the actual number */
    });
  const score = Number(await page.locator(".ladder__score").first().textContent());
  expect(score, `expected the round's ${expected} points back`).toBe(expected);

  await page.close();
}, 240_000);
