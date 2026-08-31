/**
 * True where the primary input has no hover — a phone or a tablet.
 *
 * Focusing a field raises the keyboard there, which is not something to do to
 * somebody who has not asked for it: it covers half the screen and shoves the
 * layout around. Anything that would take focus on arrival has to check this.
 */
export const isTouch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;
