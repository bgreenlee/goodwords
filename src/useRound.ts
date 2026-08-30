import { useEffect, useState } from "react";
import { roundAt, type RoundState } from "./game/schedule";

/**
 * Tracks the globally scheduled round.
 *
 * Every update re-reads the wall clock rather than counting elapsed ticks, so the
 * countdown cannot drift however unreliable the timer is — and browsers make it
 * unreliable: intervals are throttled to once a second in a hidden tab, once a
 * minute after a few minutes there, and stop altogether while a laptop sleeps.
 * The animation frame is paused in those cases too, so the clock is also re-read
 * whenever the page is shown or refocused, making it correct the instant it is
 * visible again.
 */
export function useRound(): RoundState {
  const [state, setState] = useState(() => roundAt(Date.now()));

  useEffect(() => {
    let frame = 0;

    const sync = () =>
      setState((prev) => {
        const next = roundAt(Date.now());
        // Only re-render when something on screen actually changes: the clock is
        // shown to the second, so five updates a second would be four too many.
        const same =
          next.round === prev.round &&
          next.phase === prev.phase &&
          Math.ceil(next.remainingMs / 1000) === Math.ceil(prev.remainingMs / 1000);
        return same ? prev : next;
      });

    const loop = () => {
      sync();
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("pageshow", sync);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return state;
}
