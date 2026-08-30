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
