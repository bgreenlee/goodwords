/** First run, resuming after a refresh, and the record of past games. */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rollBoard } from "../src/game/dice";
import { PLAY_MS, ROUND_MS } from "../src/game/schedule";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { installClock, seedReturningPlayer } from "./pagesetup";

const PORT = 4199;
const URL = `http://localhost:${PORT}/`;
const ROUND = 1_000_000;

let server: ReturnType<typeof spawn>;
let browser: Browser;

beforeAll(async () => {
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    stdio: "ignore",
  });
  browser = await chromium.launch();
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("preview server never came up");
}, 45_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

const words = readFileSync("public/data/words.txt", "utf8").split("\n");
const solutionFor = (round: number) => [...solveBoard(rollBoard(round), new Trie(words))];

test("a first visit explains the game and will not start without a name", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await installClock(page, ROUND * ROUND_MS + 30_000);
  await page.goto(URL);

  await page.waitForSelector(".sheet");
  const text = await page.locator(".sheet").innerText();
  expect(text).toContain("Four letters or more");
  expect(text).toContain("Space");

  // No board behind the dialog, and no way past it empty-handed.
  expect(await page.locator(".sheet__go").isDisabled()).toBe(true);
  await page.keyboard.press("Escape");
  expect(await page.locator(".sheet").count()).toBe(1);

  await page.locator(".sheet__input").fill("ada");
  expect(await page.locator(".sheet__go").isDisabled()).toBe(false);
  await page.locator(".sheet__go").click();

  await page.waitForSelector(".tile");
  expect(await page.locator(".sheet").count()).toBe(0);
  expect(await page.locator(".topbar__who").textContent()).toBe("ada");

  // The welcome does not come back for a player who has already been through it.
  await page.reload();
  await page.waitForSelector(".tile");
  expect(await page.locator(".sheet").count()).toBe(0);
  await page.close();
}, 45_000);

test("how to play can be reopened, and holds the keyboard while it is up", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page, "ada");
  await installClock(page, ROUND * ROUND_MS + 30_000);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  const board = await page.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()));
  await page.locator(".topbar__btn", { hasText: "How to play" }).click();
  await page.waitForSelector(".sheet");

  // Typing must go to the dialog, and space must not turn the board behind it.
  await page.keyboard.press("Space");
  await page.keyboard.type("zz");
  expect(await page.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()))).toEqual(board);
  expect(await page.locator(".entry__input").inputValue()).toBe("");

  await page.keyboard.press("Escape");
  expect(await page.locator(".sheet").count()).toBe(0);
  await page.close();
}, 45_000);

test("a refresh puts the words already found back on the board", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page, "ada");
  await installClock(page, ROUND * ROUND_MS + 20_000);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  const picks = solutionFor(ROUND).slice(0, 3);
  for (const w of picks) {
    await page.locator(".entry__input").fill(w);
    await page.locator(".entry__input").press("Enter");
  }
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 3);

  await page.reload();
  await page.waitForSelector(".tile");
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 3, {
    timeout: 10_000,
  });
  const restored = await page.$$eval(".guesses__word", (els) => els.map((e) => e.textContent));
  expect(restored.sort()).toEqual([...picks].sort());

  // A different board must not inherit them.
  await page.evaluate(
    (ms) => (window as never as { __setNow: (n: number) => void }).__setNow(ms),
    (ROUND + 5) * ROUND_MS + 20_000,
  );
  await page.waitForFunction(
    () => document.querySelectorAll(".guesses li").length === 0,
    undefined,
    {
      timeout: 10_000,
    },
  );
  await page.close();
}, 60_000);

test("a finished round is kept and can be looked over later", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page, "ada");
  await installClock(page, ROUND * ROUND_MS + PLAY_MS - 4000);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  const board = await page.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()));
  const pick = solutionFor(ROUND)[0];
  await page.locator(".entry__input").fill(pick);
  await page.locator(".entry__input").press("Enter");

  // Ride into the break, which is when the round is scored and filed.
  await page.waitForSelector(".clock--break", { timeout: 15_000 });
  await page.waitForSelector(".vocab__item", { timeout: 15_000 });
  await page.waitForFunction(
    () => (document.querySelector(".topbar__btn")?.textContent ?? "").includes("·"),
    undefined,
    { timeout: 10_000 },
  );

  await page.locator(".topbar__btn", { hasText: "Games" }).click();
  await page.waitForSelector(".past__item");
  expect(await page.locator(".past__item").count()).toBe(1);

  // The stored game shows the board it was played on and the word that was found.
  expect(await page.$$eval(".sheet .tile", (els) => els.map((e) => e.textContent!.trim()))).toEqual(
    board,
  );
  expect(await page.locator(".sheet .guesses__word").allTextContents()).toEqual([pick]);
  expect(await page.locator(".sheet .vocab__item").count()).toBeGreaterThan(0);

  // The round was named for a word; the record should say which, and light it.
  const kept = await page.locator(".sheet .clue").innerText();
  expect(kept).toMatch(/BONUS WORD/i);
  const named = await page.locator(".sheet .clue__word").textContent();
  expect(named, "the stored game should name its bonus word").toBeTruthy();
  const lit = await page.$$eval(".sheet .tile--lit", (els) =>
    els
      .map((e) => e.textContent!.trim().toLowerCase())
      .sort()
      .join(""),
  );
  expect(lit).toBe(named!.toLowerCase().split("").sort().join(""));

  // It survives a reload, which is the point of keeping it.
  await page.locator(".sheet__close").click();
  await page.reload();
  await page.waitForSelector(".tile");
  await page.locator(".topbar__btn", { hasText: "Games" }).click();
  await page.waitForSelector(".past__item");
  expect(await page.locator(".past__item").count()).toBe(1);
  await page.close();
}, 90_000);

test("a round you did not play is not kept as a game", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page, "ada");
  await installClock(page, ROUND * ROUND_MS + PLAY_MS - 4000);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  // Sit out the round entirely, the way an open tab does.
  await page.waitForSelector(".clock--break", { timeout: 15_000 });
  await page.waitForSelector(".vocab__item", { timeout: 15_000 });
  await page.waitForTimeout(1000);

  // The definitions still show — you just were not playing, so nothing is filed.
  expect(await page.locator(".vocab__item").count()).toBeGreaterThan(0);
  expect(await page.locator(".topbar__btn", { hasText: "Games" }).textContent()).toBe("Games");
  expect(await page.locator(".topbar__stat").textContent()).toBe("0 words seen");

  await page.locator(".topbar__btn", { hasText: "Games" }).click();
  await page.waitForSelector(".sheet");
  expect(await page.locator(".past__item").count()).toBe(0);

  const stored = await page.evaluate(() => localStorage.getItem("goodwords.games"));
  expect(stored === null || stored === "[]").toBe(true);
  await page.close();
}, 60_000);

test("the board in a past game fits its column at any width", async () => {
  const board = "IAELNORWPILRABOAEYVYASEET".split("");
  board[18] = "QU"; // the widest tile, and the one that overflows first
  const games = [
    {
      round: 9_000_003,
      board,
      words: ["sear", "roles", "barres"],
      score: 6,
      total: 469,
      possible: 218,
      taught: [
        { lemma: "rictus", word: "rictus", partOfSpeech: "noun", gloss: "a gaping grimace" },
      ],
      at: Date.now() - 400_000,
    },
    // A round nobody played, from before those stopped being filed.
    {
      round: 9_000_002,
      board,
      words: [],
      score: 0,
      total: 322,
      possible: 322,
      taught: [],
      at: Date.now() - 600_000,
    },
  ];

  for (const width of [1440, 1100, 1000, 820]) {
    const page = await browser.newPage({ viewport: { width, height: 950 } });
    await seedReturningPlayer(page, "ada");
    await page.addInitScript(
      ([stored]) => localStorage.setItem("goodwords.games", stored),
      [JSON.stringify(games)],
    );
    await page.goto(URL);
    await page.waitForSelector(".tile");
    await page.locator(".topbar__btn", { hasText: "Games" }).click();
    await page.waitForSelector(".past__item");

    // Rounds with no words are dropped on the way past, not just on the way in.
    expect(await page.locator(".past__item").count(), `at ${width}px`).toBe(1);

    const fit = await page.evaluate(() => {
      const board = document.querySelector(".sheet .board")!;
      const tiles = [...board.querySelectorAll(".tile")];
      const b = board.getBoundingClientRect();
      const w = document.querySelector(".past__cols")!.getBoundingClientRect();
      // Below 900px the two stack, so overlap has to mean the boxes actually
      // intersect, not merely that they share a horizontal range.
      return {
        spill: Math.round(Math.max(...tiles.map((t) => t.getBoundingClientRect().right)) - b.right),
        overlaps:
          b.right > w.left + 1 &&
          b.left < w.right - 1 &&
          b.bottom > w.top + 1 &&
          b.top < w.bottom - 1,
        clipped: tiles.some((t) => t.scrollWidth > t.clientWidth + 1),
      };
    });
    expect(fit.spill, `tiles overflow the board at ${width}px`).toBeLessThanOrEqual(1);
    expect(fit.overlaps, `board overlaps the words list at ${width}px`).toBe(false);
    expect(fit.clipped, `a letter is clipped at ${width}px`).toBe(false);
    await page.close();
  }
}, 90_000);

test("when the round ends the bonus word is named and shown on the board", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page, "ada");
  await installClock(page, ROUND * ROUND_MS + PLAY_MS - 4000);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  // During play the clue gives the definition and the length, never the word.
  const clue = await page.locator(".clue").innerText();
  expect(clue).toMatch(/BONUS WORD · \d+ LETTERS/i);
  expect(await page.locator(".tile--lit").count()).toBe(0);

  await page.waitForSelector(".clock--break", { timeout: 15_000 });
  await page.waitForTimeout(600);

  // Now it is named, and lit on the board so you can see where it was.
  const named = await page.locator(".clue__word").textContent();
  expect(named, "the bonus word should be revealed at the end").toBeTruthy();

  const lit = await page.$$eval(".tile--lit", (els) =>
    els
      .map((e) => e.textContent!.trim().toLowerCase())
      .sort()
      .join(""),
  );
  const letters = named!.toLowerCase().split("").sort().join("");
  expect(lit, `board lit "${lit}" for bonus word "${named}"`).toBe(letters);

  await page.close();
}, 60_000);
