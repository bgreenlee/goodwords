/**
 * Playing on a phone, in WebKit — the engine iOS runs.
 *
 * The keyboard does not resize the window on iOS; it shrinks the visual viewport
 * and the browser scrolls the focused input into view by its own reckoning, which
 * put the board off the top of the screen. There is no keyboard in a headless
 * browser, so the viewport is simply set to what one leaves behind.
 */
import { spawn } from "node:child_process";
import { webkit, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { PLAY_MS, ROUND_MS } from "../src/game/schedule";
import { readFileSync } from "node:fs";
import { rollBoard } from "../src/game/dice";
import { findPath, solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";

const PORT = 4225;
const URL = `http://localhost:${PORT}/`;
const ROUND = 1_000_000;

let server: ReturnType<typeof spawn>;
let browser: Browser;

beforeAll(async () => {
  server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    stdio: "ignore",
  });
  browser = await webkit.launch();
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(URL)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("preview server never came up");
}, 60_000);

afterAll(async () => {
  await browser?.close();
  server?.kill();
});

/** Sizes left by the keyboard on the phones people actually hold. */
const PHONES: Array<[string, number, number]> = [
  ["iPhone SE", 375, 400],
  ["iPhone 13", 390, 440],
  ["iPhone Pro Max", 430, 500],
];

for (const [name, width, height] of PHONES) {
  test(`${name}: the board stays on screen when the word box is tapped`, async () => {
    const page = await browser.newPage({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
    });
    await page.addInitScript(`(() => {
      localStorage.setItem("goodwords.profile",
        JSON.stringify({ id: "mobile-test-0001", name: "ada", welcomed: true, learned: [] }));
      const t = ${ROUND * ROUND_MS + PLAY_MS - 60_000}, real = Date.now, t0 = real();
      Date.now = () => t + (real() - t0);
    })();`);
    await page.goto(URL);
    await page.waitForSelector(".tile");
    // Nothing should be focused on arrival: focusing scrolls the page, and on a
    // phone it cannot raise the keyboard anyway.
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");

    await page.locator(".entry__input").tap();
    await page.waitForTimeout(900);

    const seen = await page.evaluate(() => {
      const onScreen = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.top >= -1 && r.bottom <= window.innerHeight + 1;
      };
      const tiles = [...document.querySelectorAll(".tile")];
      return {
        board: onScreen(document.querySelector(".board")!),
        input: onScreen(document.querySelector(".entry__input")!),
        clock: onScreen(document.querySelector(".clock")!),
        everyTile: tiles.every(onScreen),
        tile: Math.round(tiles[0].getBoundingClientRect().width),
      };
    });

    expect(seen.input, "the word box must be visible").toBe(true);
    expect(seen.board, "the board must not be scrolled off").toBe(true);
    expect(seen.everyTile, "every tile must be reachable").toBe(true);
    expect(seen.clock, "the clock must be visible").toBe(true);
    // Small is fine; illegible is not.
    expect(seen.tile, `tiles were ${seen.tile}px`).toBeGreaterThanOrEqual(24);

    // And typing still works from there.
    await page.keyboard.type("zzzz");
    expect(await page.locator(".entry__input").inputValue()).toBe("zzzz");
    await page.close();
  }, 60_000);
}

test("a word can be tapped out without ever raising the keyboard", async () => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await page.addInitScript(`(() => {
    localStorage.setItem("goodwords.profile",
      JSON.stringify({ id: "tap-test-0001", name: "ada", welcomed: true, learned: [] }));
    const t = ${ROUND * ROUND_MS + PLAY_MS - 60_000}, real = Date.now, t0 = real();
    Date.now = () => t + (real() - t0);
  })();`);
  await page.goto(URL);
  await page.waitForSelector(".tile");

  const board = rollBoard(ROUND);
  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const target = [...solveBoard(board, new Trie(words))].find(
    (w) => w.length >= 5 && w.length <= 7,
  )!;
  const cells = findPath(board, target)!;
  expect(cells.length).toBeGreaterThan(3);

  await page.waitForSelector("button.tile");
  const tile = (i: number) => page.locator(".tile").nth(i);
  for (const cell of cells) await tile(cell).tap();
  expect(await page.locator(".entry__input").inputValue()).toBe(target);
  expect(await page.locator(".tile--chosen").count()).toBe(cells.length);

  await page.locator(".entry__btn--go").tap();
  await page.waitForFunction((n) => document.querySelectorAll(".guesses li").length === n, 1);
  expect(await page.locator(".guesses__word").first().textContent()).toBe(target);

  // The whole point: no keyboard, so no lost screen space.
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");
  // And the board is clear again for the next word.
  expect(await page.locator(".tile--chosen").count()).toBe(0);
  await page.close();
}, 60_000);

test("a word can only go to a touching letter, and taps can be taken back", async () => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await page.addInitScript(`(() => {
    localStorage.setItem("goodwords.profile",
      JSON.stringify({ id: "tap-test-0002", name: "ada", welcomed: true, learned: [] }));
    const t = ${ROUND * ROUND_MS + PLAY_MS - 60_000}, real = Date.now, t0 = real();
    Date.now = () => t + (real() - t0);
  })();`);
  await page.goto(URL);
  await page.waitForSelector("button.tile");
  const tile = (i: number) => page.locator(".tile").nth(i);

  // Without this Safari waits after each tap to see whether a zoom is coming,
  // which reads as lag and eats the second of two quick taps.
  expect(await tile(0).evaluate((el) => getComputedStyle(el).touchAction)).toBe("manipulation");

  // Cell 0 is a corner: three of its neighbours are reachable, the other 21 are not.
  await tile(0).tap();
  expect(await page.locator(".tile--dead").count()).toBe(21);

  // Tapping across the board does nothing at all. It has to be forced, because
  // the tile is properly aria-disabled and automation declines it on that basis —
  // which is itself the behaviour assistive tech would see.
  await tile(24).tap({ force: true });
  expect(await page.locator(".tile--chosen").count()).toBe(1);

  // A touching letter is taken.
  await tile(6).tap();
  expect(await page.locator(".tile--chosen").count()).toBe(2);

  // Tapping the last letter takes it back; the undo button takes back the rest.
  await tile(6).tap();
  expect(await page.locator(".tile--chosen").count()).toBe(1);
  await page.locator(".entry__btn").first().tap();
  expect(await page.locator(".tile--chosen").count()).toBe(0);
  expect(await page.locator(".entry__input").inputValue()).toBe("");
  await page.close();
}, 60_000);

test("tapping never pushes the page sideways", async () => {
  // The undo and enter buttons appear once a word is started, and a grid track of
  // plain 1fr could not shrink below them, so the whole column ran off the screen.
  for (const [width, height] of [
    [320, 568],
    [375, 667],
    [390, 440],
    [390, 844],
  ] as const) {
    const page = await browser.newPage({
      viewport: { width, height },
      isMobile: true,
      hasTouch: true,
    });
    await page.addInitScript(`(() => {
      localStorage.setItem("goodwords.profile",
        JSON.stringify({ id: "overflow-test", name: "ada", welcomed: true, learned: [] }));
      const t = ${ROUND * ROUND_MS + PLAY_MS - 60_000}, real = Date.now, t0 = real();
      Date.now = () => t + (real() - t0);
    })();`);
    await page.goto(URL);
    await page.waitForSelector("button.tile");

    const sideways = () =>
      page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await sideways(), `${width}px before tapping`).toBeLessThanOrEqual(0);

    for (const cell of [0, 1, 2, 6]) await page.locator(".tile").nth(cell).tap();
    expect(await sideways(), `${width}px after tapping`).toBeLessThanOrEqual(0);
    expect(
      await page.locator(".entry__btn--go").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.right <= window.innerWidth + 1 && r.left >= -1;
      }),
      `the enter button is off screen at ${width}px`,
    ).toBe(true);
    await page.close();
  }
}, 90_000);

test("quick taps all land", async () => {
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await page.addInitScript(`(() => {
    localStorage.setItem("goodwords.profile",
      JSON.stringify({ id: "rapid-test", name: "ada", welcomed: true, learned: [] }));
    const t = ${ROUND * ROUND_MS + PLAY_MS - 60_000}, real = Date.now, t0 = real();
    Date.now = () => t + (real() - t0);
  })();`);
  await page.goto(URL);
  await page.waitForSelector("button.tile");

  const board = rollBoard(ROUND);
  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const target = [...solveBoard(board, new Trie(words))].find((w) => w.length >= 6)!;
  const cells = findPath(board, target)!;

  // Tap by coordinate without waiting between, the way a fast player does.
  const points: Array<[number, number]> = [];
  for (const cell of cells) {
    const box = (await page.locator(".tile").nth(cell).boundingBox())!;
    points.push([box.x + box.width / 2, box.y + box.height / 2]);
  }
  for (const [x, y] of points) await page.touchscreen.tap(x, y);
  await page.waitForTimeout(250);

  expect(await page.locator(".entry__input").inputValue(), "a tap went missing").toBe(target);
  await page.close();
}, 60_000);
