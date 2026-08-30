import type { Page } from "playwright";

/**
 * Present as a player who has been here before. Without this every page starts at
 * the welcome, which is its own test rather than a preamble to all the others.
 */
export async function seedReturningPlayer(page: Page, name = "tester") {
  await page.addInitScript(
    ([n]) => {
      localStorage.setItem(
        "goodwords.profile",
        JSON.stringify({ name: n, welcomed: true, learned: [] }),
      );
    },
    [name],
  );
}

/** Run the page on a clock we control, so a round boundary can be forced. */
export async function installClock(page: Page, at: number) {
  await page.addInitScript(`(() => {
    let target = ${at};
    const real = Date.now;
    let t0 = real();
    Date.now = () => target + (real() - t0);
    window.__setNow = (ms) => { target = ms; t0 = real(); };
  })();`);
}
