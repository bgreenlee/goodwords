/**
 * Every client computes the current round from the wall clock, so all players see
 * the same board at the same time with no server coordination.
 */
export const PLAY_MS = 3 * 60 * 1000;
export const BREAK_MS = 30 * 1000;
export const ROUND_MS = PLAY_MS + BREAK_MS;

export type Phase = "playing" | "break";

export type RoundState = {
  round: number;
  phase: Phase;
  /** Milliseconds until the current phase ends. */
  remainingMs: number;
};

export function roundAt(now: number): RoundState {
  const round = Math.floor(now / ROUND_MS);
  const elapsed = now - round * ROUND_MS;
  return elapsed < PLAY_MS
    ? { round, phase: "playing", remainingMs: PLAY_MS - elapsed }
    : { round, phase: "break", remainingMs: ROUND_MS - elapsed };
}

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
