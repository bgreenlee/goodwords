import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { installClock, seedReturningPlayer } from "./pagesetup";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rollBoard, rotatedOrder } from "../src/game/dice";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { PLAY_MS, ROUND_MS } from "../src/game/schedule";

const PORT = 4183;
const URL = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOT_DIR ?? "/tmp";

// Land mid-round with 6 seconds of play left, so the break arrives during the test.
const ROUND = 1_000_000;
const START = ROUND * ROUND_MS + PLAY_MS - 6000;

let server: ReturnType<typeof spawn>;
let browser: Browser;

beforeAll(async () => {
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    stdio: "ignore",
  });
  browser = await chromium.launch();
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(URL);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("preview server never came up");
}, 45_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

test("plays a round in a real browser", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page);
  await installClock(page, START);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(URL);
  await page.waitForSelector(".tile");

  // With no room to join, the game falls back to the clock-derived board and says so.
  expect(await page.getAttribute("[data-room]", "data-room")).toBe("solo");

  // The rendered board must match what the same round produces here.
  const rendered = await page.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()));
  expect(rendered).toEqual(rollBoard(ROUND));

  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const solution = [...solveBoard(rollBoard(ROUND), new Trie(words))];
  expect(solution.length).toBeGreaterThan(30);

  const input = page.locator(".entry__input");
  const picks = solution.slice(0, 4);
  for (const w of picks) {
    await input.fill(w);
    await input.press("Enter");
  }
  await page.waitForFunction(
    (n) => document.querySelectorAll(".guesses li").length === n,
    picks.length,
  );

  // Rejections must be explained, not silently swallowed.
  await input.fill("zzzzq");
  await input.press("Enter");
  expect(await page.locator(".feedback").textContent()).toContain("dictionary");
  await input.fill(picks[0]);
  await input.press("Enter");
  expect(await page.locator(".feedback").textContent()).toContain("Already found");

  // Let the tile highlight finish fading in before capturing.
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/goodwords-playing.png` });

  // Ride the clock into the break and confirm the vocabulary column fills in.
  await page.waitForSelector(".clock--break", { timeout: 15_000 });
  await page.waitForSelector(".vocab__item", { timeout: 15_000 });
  const defs = await page.$$eval(".vocab__item", (els) =>
    els.map((e) => ({
      lemma: e.querySelector(".vocab__word")!.textContent!.trim(),
      // Present only when the board spelling differs from the headword.
      via: e.querySelector(".vocab__via")?.textContent?.match(/“(.+)”/)?.[1] ?? null,
      gloss: e.querySelector(".vocab__gloss")!.textContent!.trim(),
    })),
  );
  expect(defs.length).toBeGreaterThan(0);
  for (const d of defs) {
    expect(d.gloss.length).toBeGreaterThan(3);
    // Never teach a word the player already found.
    expect(picks).not.toContain(d.via ?? d.lemma);
    // Every headword shown must be one the board could actually spell.
    expect(solution).toContain(d.via ?? d.lemma);
  }
  console.log("\ndefinitions shown:");
  for (const d of defs) console.log(`  ${d.lemma} — ${d.gloss}`);

  expect(await page.locator(".entry__input").isDisabled()).toBe(true);

  // During the break the board stays readable, and pointing at a missed word
  // traces where it was hiding.
  expect(await page.locator(".board").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
  expect(await page.locator(".tile--lit").count()).toBe(0);

  const boardWord = defs[0].via ?? defs[0].lemma;
  await page.locator(".vocab__item").first().hover();
  await page.waitForFunction(() => document.querySelectorAll(".tile--lit").length > 0, undefined, {
    timeout: 5000,
  });
  const litCount = await page.locator(".tile--lit").count();
  // One tile per cell used; a Qu tile covers two letters, so the path can be shorter.
  expect(litCount, `tracing ${boardWord}`).toBeLessThanOrEqual(boardWord.length);
  expect(litCount).toBeGreaterThanOrEqual(boardWord.length - 1);

  // The tiles must actually change colour, not merely gain a class: the highlight
  // fades in, so assert the painted result rather than the markup.
  await page.waitForFunction(
    () => {
      const lit = document.querySelector(".tile--lit");
      const plain = document.querySelector(".tile:not(.tile--lit)");
      if (!lit || !plain) return false;
      return getComputedStyle(lit).backgroundColor !== getComputedStyle(plain).backgroundColor;
    },
    undefined,
    { timeout: 5000 },
  );
  await page.waitForTimeout(300); // let the fade finish before capturing

  await page.screenshot({ path: `${SHOTS}/goodwords-break.png` });

  expect(errors, errors.join("\n")).toEqual([]);
}, 60_000);

test("a round the player never saw is not scored against them", async () => {
  // A laptop that sleeps mid-round wakes with the clock far ahead. If it lands in
  // some later round's break, the words typed on the old board must not be counted
  // as finds on a board the player never saw.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page);
  await installClock(page, ROUND * ROUND_MS + 60_000);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.waitForSelector(".tile");

  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const played = [...solveBoard(rollBoard(ROUND), new Trie(words))].slice(0, 2);
  const input = page.locator(".entry__input");
  for (const w of played) {
    await input.fill(w);
    await input.press("Enter");
  }
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 2);

  // Wake up three rounds later, during the break.
  const wake = (ROUND + 3) * ROUND_MS + PLAY_MS + 10_000;
  await page.evaluate(
    (ms) => (window as never as { __setNow: (n: number) => void }).__setNow(ms),
    wake,
  );
  await page.waitForSelector(".clock--break", { timeout: 5000 });
  await page.waitForTimeout(700);

  // The old guesses are gone, and nothing is reported as found on the new board.
  expect(await page.locator(".guesses li").count()).toBe(0);
  const summary = (await page.locator(".feedback").textContent())?.trim() ?? "";
  expect(summary, `summary was "${summary}"`).not.toMatch(/[1-9]\d* of \d+ words/);
  expect(await page.locator(".vocab__item").count()).toBe(0);

  expect(errors, errors.join("\n")).toEqual([]);
  await page.close();
}, 45_000);

test("you can type without clicking the box, and space turns the board", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page);
  await installClock(page, ROUND * ROUND_MS + 30_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL);
  await page.waitForSelector(".tile");
  const board = rollBoard(ROUND);

  // Nothing focused: typing should still land in the word box.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.activeElement?.className ?? "")).not.toContain("entry");
  await page.keyboard.type("cat");
  expect(await page.locator(".entry__input").inputValue()).toBe("cat");
  await page.keyboard.press("Backspace");
  expect(await page.locator(".entry__input").inputValue()).toBe("ca");

  const tiles = () => page.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()));
  expect(await tiles()).toEqual(board);

  // Space turns the board even while the word box has focus, because a space is
  // never part of a word.
  await page.keyboard.press(" ");
  expect(await tiles()).toEqual(rotatedOrder(1).map((c) => board[c]));
  expect(await page.locator(".entry__input").inputValue()).toBe("ca");

  await page.locator(".clock__rotate").click();
  expect(await tiles()).toEqual(rotatedOrder(2).map((c) => board[c]));

  await page.keyboard.press(" ");
  await page.keyboard.press(" ");
  expect(await tiles()).toEqual(board);

  // A turned board must still accept the words it could spell before.
  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const word = [...solveBoard(board, new Trie(words))][0];
  await page.keyboard.press(" ");
  await page.locator(".entry__input").fill(word);
  await page.locator(".entry__input").press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 1);

  // A space typed into a dialog's field must stay a space, not turn the board.
  await page.locator(".topbar__btn", { hasText: "How to play" }).click();
  await page.waitForSelector(".sheet__input");
  await page.locator(".sheet__input").fill("ada");
  await page.locator(".sheet__input").press(" ");
  await page.locator(".sheet__input").type("l");
  expect(await page.locator(".sheet__input").inputValue()).toBe("ada l");
  await page.keyboard.press("Escape");

  expect(errors, errors.join("\n")).toEqual([]);
  await page.close();
}, 45_000);

test("the clock keeps ticking", async () => {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  await seedReturningPlayer(page);
  await installClock(page, ROUND * ROUND_MS + 30_000);
  await page.goto(URL);
  await page.waitForSelector(".clock__time");

  const seen = new Set<string>();
  for (let i = 0; i < 25; i++) {
    seen.add((await page.locator(".clock__time").textContent())!);
    await page.waitForTimeout(200);
  }
  // Five seconds of wall time must show about five distinct seconds.
  expect(seen.size, [...seen].join(",")).toBeGreaterThanOrEqual(4);
  await page.close();
}, 30_000);

test("an accepted word flashes on the board and then fades", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page);
  await installClock(page, ROUND * ROUND_MS + 30_000);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const solution = [...solveBoard(rollBoard(ROUND), new Trie(words))];
  const input = page.locator(".entry__input");

  await input.fill(solution[0]);
  await input.press("Enter");

  // Lit straight away, so the path is actually seen.
  await page.waitForFunction(() => document.querySelectorAll(".tile--lit").length > 0, undefined, {
    timeout: 2000,
  });
  // Then gone, rather than sitting there competing with the next word.
  await page.waitForFunction(
    () => document.querySelectorAll(".tile--lit").length === 0,
    undefined,
    {
      timeout: 4000,
    },
  );
  // Nothing is left mid-fade: every tile is back to the resting colour.
  await page.waitForFunction(
    () => {
      const tiles = [...document.querySelectorAll(".tile")];
      const colours = new Set(tiles.map((t) => getComputedStyle(t).backgroundColor));
      return colours.size === 1;
    },
    undefined,
    { timeout: 4000 },
  );

  // A second word lights up again; the fade must not be a one-off.
  await input.fill(solution[1]);
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".tile--lit").length > 0, undefined, {
    timeout: 2000,
  });

  await page.close();
}, 45_000);

test("tracing a missed word stays lit while pointed at", async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page);
  await installClock(page, ROUND * ROUND_MS + PLAY_MS - 3000);
  await page.goto(URL);
  await page.waitForSelector(".tile");
  await page.waitForSelector(".clock--break", { timeout: 15_000 });
  await page.waitForSelector(".vocab__item", { timeout: 15_000 });

  await page.locator(".vocab__item").first().hover();
  await page.waitForFunction(() => document.querySelectorAll(".tile--lit").length > 0, undefined, {
    timeout: 5000,
  });
  // Well past the flash timeout: hovering is a held state, not a confirmation.
  await page.waitForTimeout(1800);
  expect(await page.locator(".tile--lit").count()).toBeGreaterThan(0);

  await page.close();
}, 45_000);

test("the word you just typed is the word the board lights up", async () => {
  // Reported from real play: typed a word, got the credit, and an earlier word was
  // highlighted. Guesses are prepended, so the rows slide down under a pointer that
  // has not moved, and mouseenter fires on whichever old word arrives under it.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await seedReturningPlayer(page);
  await installClock(page, ROUND * ROUND_MS + 30_000);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const solution = [...solveBoard(rollBoard(ROUND), new Trie(words))];
  // Different opening letters, so a wrong highlight cannot look like a right one.
  const picks = solution.filter((w, i, a) => a.findIndex((x) => x[0] === w[0]) === i).slice(0, 6);
  expect(picks.length).toBe(6);

  const entry = page.locator(".entry__input");
  for (const w of picks.slice(0, 5)) {
    await entry.fill(w);
    await entry.press("Enter");
  }
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 5);

  // Rest the pointer partway down the list, as you would after glancing at it.
  await page.locator(".guesses li").nth(3).hover();
  await page.waitForTimeout(250);

  const fresh = picks[5];
  await page.keyboard.type(fresh);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 6);
  await page.waitForTimeout(200);

  // Lit tiles are in board order, so compare letters rather than spelling. A Qu
  // tile carries two of them.
  const letters = (s: string) => s.toLowerCase().split("").sort().join("");
  const lit = await page.$$eval(".tile--lit", (els) =>
    els.map((e) => e.textContent!.trim()).join(""),
  );
  expect(letters(lit), `typed "${fresh}" but the board lit letters of "${lit}"`).toBe(
    letters(fresh),
  );

  await page.close();
}, 60_000);
