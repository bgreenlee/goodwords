/**
 * True where the primary input has no hover — a phone or a tablet.
 *
 * Focusing a field raises the keyboard there, which is not something to do to
 * somebody who has not asked for it: it covers half the screen and shoves the
 * layout around. Anything that takes focus *unprompted* — on arrival, or after a
 * dialog is dismissed — has to check this first.
 *
 * Focus in direct response to a keystroke is a different matter and should not
 * check it. Somebody who just typed a letter has a keyboard already, and gating
 * that would stop typing working on a tablet with one attached, which reports no
 * hover like any other tablet.
 */
export const isTouch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;
