import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { rollBoard } from "../src/game/dice";
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
  await page.addInitScript(`(() => {
    const target = ${START};
    const real = Date.now;
    const t0 = real();
    Date.now = () => target + (real() - t0);
  })();`);

  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(URL);
  await page.waitForSelector(".tile");

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
