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

  // It survives a reload, which is the point of keeping it.
  await page.locator(".sheet__close").click();
  await page.reload();
  await page.waitForSelector(".tile");
  await page.locator(".topbar__btn", { hasText: "Games" }).click();
  await page.waitForSelector(".past__item");
  expect(await page.locator(".past__item").count()).toBe(1);
  await page.close();
}, 90_000);
