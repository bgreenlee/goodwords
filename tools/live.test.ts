/** Two real browsers against the deployed site. Run with `npm run live`. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { roundAt } from "../src/game/schedule";

const HOST = process.env.LIVE_HOST ?? "goodwords.fun";
const IP = process.env.LIVE_IP;

test("two browsers play each other on the deployed site", async () => {
  for (;;) {
    const { phase, remainingMs } = roundAt(Date.now());
    if (phase === "playing" && remainingMs > 45_000) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const browser = await chromium.launch({
    args: IP ? [`--host-resolver-rules=MAP ${HOST} ${IP}`] : [],
  });
  const join = async (name: string) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`https://${HOST}/`);
    await page.waitForSelector('[data-room="live"]', { timeout: 30_000 });
    await page.waitForSelector(".tile");
    await page.locator(".topbar__name").fill(name);
    return page;
  };

  const ada = await join("ada");
  const grace = await join("grace");
  const tiles = (p: Awaited<ReturnType<typeof join>>) =>
    p.$$eval(".tile", (els) => els.map((e) => e.textContent!.trim()));

  const board = await tiles(ada);
  expect(await tiles(grace)).toEqual(board);

  const trie = new Trie(readFileSync("public/data/words.txt", "utf8").split("\n"));
  const solution = [...solveBoard(board, trie)].sort((x, y) => y.length - x.length);
  expect(solution.length).toBeGreaterThan(20);

  const play = async (p: Awaited<ReturnType<typeof join>>, w: string) => {
    await p.locator(".entry__input").fill(w);
    await p.locator(".entry__input").press("Enter");
  };
  await play(ada, solution[0]);
  await play(grace, solution[solution.length - 1]);

  for (const page of [ada, grace]) {
    await page.waitForFunction(
      () => document.querySelectorAll(".ladder__row").length >= 2,
      undefined,
      {
        timeout: 15_000,
      },
    );
    const names = await page.$$eval(".ladder__name", (els) =>
      els.map((e) => e.textContent!.trim()),
    );
    expect(names.sort()).toEqual(["ada", "grace"]);
    expect(await page.locator(".ladder__row--you").count()).toBe(1);
  }
  await ada.screenshot({ path: `${process.env.SHOT_DIR ?? "/tmp"}/goodwords-live-mp.png` });
  await browser.close();
}, 300_000);
