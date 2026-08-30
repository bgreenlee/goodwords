import { useEffect, type RefObject } from "react";

/**
 * Publishes the height actually visible as `--play-space`.
 *
 * On iOS the keyboard does not resize the window; it shrinks the visual viewport
 * and then scrolls the focused input into view, which on a small screen pushes the
 * board off the top. Knowing the real height lets the board size itself to what is
 * left, so the board and the word box can be on screen together.
 */
export function usePlaySpace(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const publish = () => {
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--play-space", `${Math.round(height)}px`);
    };
    publish();
    if (!viewport) {
      window.addEventListener("resize", publish);
      return () => window.removeEventListener("resize", publish);
    }
    viewport.addEventListener("resize", publish);
    viewport.addEventListener("scroll", publish);
    return () => {
      viewport.removeEventListener("resize", publish);
      viewport.removeEventListener("scroll", publish);
    };
  }, []);
}

/**
 * Keeps the board on screen when the word box takes focus.
 *
 * A browser scrolls a focused input into view by its own reckoning, and on a phone
 * it picks a position that leaves the board above the top of the screen. Once the
 * board has been sized to fit, the whole game panel fits too — so put the panel at
 * the top of the viewport and let the keyboard have the rest.
 *
 * Only on touch, where a keyboard actually appears; nudging the page on a desktop
 * would be meddling.
 */
export function useKeepBoardVisible(field: RefObject<HTMLInputElement | null>): void {
  useEffect(() => {
    if (!window.matchMedia("(hover: none)").matches) return;

    const align = () => {
      if (document.activeElement !== field.current) return;
      document.querySelector(".panel--game")?.scrollIntoView({ block: "start" });
    };
    // The browser scrolls after the focus event and again when the keyboard has
    // finished animating, so correct it at both moments.
    const onFocus = () => {
      requestAnimationFrame(align);
      setTimeout(align, 350);
    };

    const input = field.current;
    input?.addEventListener("focus", onFocus);
    window.visualViewport?.addEventListener("resize", align);
    return () => {
      input?.removeEventListener("focus", onFocus);
      window.visualViewport?.removeEventListener("resize", align);
    };
  }, [field]);
}
