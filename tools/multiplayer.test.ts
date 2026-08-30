import { rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import { seedReturningPlayer } from "./pagesetup";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rollBoard } from "../src/game/dice";
import { roundAt } from "../src/game/schedule";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";

/** Durable object state for this suite alone, so runs cannot contaminate each other. */
const STATE = ".wrangler/state-multiplayer";
const PORT = 8791;
const URL = `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOT_DIR ?? "/tmp";

let server: ReturnType<typeof spawn>;
let browser: Browser;
const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));

beforeAll(async () => {
  rmSync(STATE, { recursive: true, force: true });
  server = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--local", "--persist-to", STATE],
    {
      stdio: "ignore",
    },
  );
  browser = await chromium.launch();
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev never came up");
}, 90_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

/** The server scores against the real clock; start with enough play time left. */
async function waitForPlayTime(minMs = 30_000) {
  for (;;) {
    const { phase, remainingMs } = roundAt(Date.now());
    if (phase === "playing" && remainingMs > minMs) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function join(name: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page, name);
  await page.goto(URL);
  await page.waitForSelector(".tile");
  // The leaderboard reports "live" only once the socket has dealt a board.
  await page.waitForSelector('[data-room="live"]', { timeout: 20_000 });
  return page;
}

const tilesOf = (page: Page) =>
  page.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()));
const ladderOf = (page: Page) =>
  page.$$eval(".ladder__row", (els) =>
    els.map((e) => ({
      name: e.querySelector(".ladder__name")!.textContent!.trim(),
      score: Number(e.querySelector(".ladder__score")!.textContent),
    })),
  );

test("two players share a server-dealt board and see each other score", async () => {
  await waitForPlayTime();
  const ada = await join("ada");
  const grace = await join("grace");

  const board = await tilesOf(ada);
  expect(await tilesOf(grace)).toEqual(board);

  // The board must come from the server, not from the clock: a board anyone can
  // derive in advance can be solved in advance.
  const round = roundAt(Date.now()).round;
  expect(board).not.toEqual(rollBoard(round));

  const solution = [...solveBoard(board, trie)].sort((a, b) => b.length - a.length);
  expect(solution.length).toBeGreaterThan(20);

  async function play(page: Page, word: string) {
    await page.locator(".entry__input").fill(word);
    await page.locator(".entry__input").press("Enter");
  }

  await play(ada, solution[0]);
  await play(grace, solution[solution.length - 1]);

  // Each player's score reaches the other's leaderboard.
  for (const page of [ada, grace]) {
    await page.waitForFunction(
      () => document.querySelectorAll(".ladder__row").length >= 2,
      undefined,
      { timeout: 10_000 },
    );
    const rows = await ladderOf(page);
    expect(rows.map((r) => r.name).sort()).toEqual(["ada", "grace"]);
    // Ada played the longest word, so she must be on top.
    expect(rows[0].name).toBe("ada");
    expect(rows[0].score).toBeGreaterThan(rows[1].score);
  }

  // Each player sees themselves highlighted, and only themselves.
  for (const page of [ada, grace]) {
    expect(await page.locator(".ladder__row--you").count()).toBe(1);
  }
  expect(await ada.locator(".ladder__row--you .ladder__name").textContent()).toBe("ada");
  expect(await grace.locator(".ladder__row--you .ladder__name").textContent()).toBe("grace");

  await ada.screenshot({ path: `${SHOTS}/goodwords-multiplayer.png` });
  await ada.close();
  await grace.close();
}, 120_000);

test("a word the board cannot spell is refused by the server", async () => {
  await waitForPlayTime(15_000);
  const page = await join("mallory");
  // Bypass the UI and speak to the room directly, the way a cheat would.
  const reply = await page.evaluate(async () => {
    const ws = new WebSocket(`ws://${location.host}/api/play`);
    await new Promise((r) => ws.addEventListener("open", r));
    ws.send(JSON.stringify({ t: "hello", name: "mallory" }));
    return await new Promise<string>((resolve) => {
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(String(e.data));
        if (m.t === "board") ws.send(JSON.stringify({ t: "word", w: "zymurgy" }));
        if (m.t === "no") resolve(m.reason);
      });
    });
  });
  expect(reply).toBe("not on this board");
  await page.close();
}, 90_000);

test("a client whose clock runs ahead waits for the deal instead of inventing a board", async () => {
  await waitForPlayTime(40_000);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page);
  // A clock that has already reached the next round, before the server has dealt
  // its board — the state every player passes through at every boundary.
  await page.addInitScript(`(() => {
    const real = Date.now;
    let skew = 0;
    Date.now = () => real() + skew;
    window.__skew = (ms) => { skew = ms; };
  })();`);
  await page.goto(URL);
  await page.waitForSelector('[data-room="live"]');
  await page.waitForSelector(".tile");

  const dealtBoard = await tilesOf(page);
  await page.evaluate(() => (window as never as { __skew: (n: number) => void }).__skew(210_000));

  // It must hold, not fall back to a board the round number implies: that board
  // belongs to nobody, and every word typed on it would be refused by the server.
  await page.waitForSelector(".board--waiting", { timeout: 5000 });
  expect(await page.locator(".tile").count()).toBe(0);
  expect(await page.locator(".entry__input").isDisabled()).toBe(true);
  expect(await page.getAttribute("[data-room]", "data-room")).toBe("live");

  // Once the clock is honest again the dealt board comes straight back.
  await page.evaluate(() => (window as never as { __skew: (n: number) => void }).__skew(0));
  await page.waitForSelector(".tile", { timeout: 5000 });
  expect(await tilesOf(page)).toEqual(dealtBoard);

  await page.close();
}, 120_000);

test("the day's standings keep a player who has already left", async () => {
  await waitForPlayTime(40_000);
  const ada = await join("ada");
  const grace = await join("grace");

  const board = await tilesOf(ada);
  const solution = [...solveBoard(board, trie)].sort((a, b) => b.length - a.length);
  await ada.locator(".entry__input").fill(solution[0]);
  await ada.locator(".entry__input").press("Enter");
  await grace.waitForFunction(
    () => document.querySelectorAll(".ladder__row").length >= 1,
    undefined,
    {
      timeout: 10_000,
    },
  );

  // Ada closes the tab mid-round. Her score should survive her connection.
  await ada.close();

  const day = grace.locator(".tabs__tab", { hasText: "Last 24 hours" });
  await day.click();
  await grace.waitForFunction(
    () => document.querySelectorAll(".ladder__row").length > 0,
    undefined,
    { timeout: 15_000 },
  );
  const names = await grace.$$eval(".ladder__name", (els) => els.map((e) => e.textContent!.trim()));
  expect(names.join(" ")).toContain("ada");

  // Switching back shows the round in progress, which is a different list.
  await grace.locator(".tabs__tab", { hasText: "This round" }).click();
  await grace.waitForTimeout(300);
  expect(await grace.locator(".tabs__tab--on").textContent()).toBe("This round");

  await grace.close();
}, 120_000);
