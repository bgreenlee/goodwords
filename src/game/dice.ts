import { rng, seedFrom } from "./rng";

/**
 * The 25 dice of Big Boggle (Parker Brothers, 1979), six faces each. The single
 * Q face is always played as "Qu", which is why no die carries a bare U beside it.
 * Distribution cross-checked against Stanford CS106X and Duke CPS100e handouts.
 */
export const BIG_BOGGLE_DICE = [
  "AAAFRS",
  "AAEEEE",
  "AAFIRS",
  "ADENNN",
  "AEEEEM",
  "AEEGMU",
  "AEGMNN",
  "AFIRSY",
  "BJKQXZ",
  "CCNSTW",
  "CEIILT",
  "CEILPT",
  "CEIPST",
  "DDLNOR",
  "DHHLOR",
  "DHHNOT",
  "DHLNOR",
  "EIIITT",
  "EMOTTT",
  "ENSSSU",
  "FIPRSY",
  "GORRVW",
  "HIPRRY",
  "NOOTUW",
  "OOOTTU",
] as const;

export const BOARD_SIZE = 5;
export const CELL_COUNT = BOARD_SIZE * BOARD_SIZE;

/** A board is 25 cell faces in row-major order; the Q die reads "QU". */
export type Board = string[];

/**
 * Roll the board for a given round. Pure: the same round always yields the same
 * board, which is what lets every client stay in sync without a server.
 */
export function rollBoard(round: number): Board {
  const next = rng(seedFrom(round));
  const dice = [...BIG_BOGGLE_DICE];
  // Fisher-Yates: which die lands in which cell.
  for (let i = dice.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [dice[i], dice[j]] = [dice[j], dice[i]];
  }
  return dice.map((die) => {
    const face = die[Math.floor(next() * die.length)];
    return face === "Q" ? "QU" : face;
  });
}

/** Cell indices adjacent to `i`, including diagonals. */
export function neighbors(i: number): number[] {
  const row = Math.floor(i / BOARD_SIZE);
  const col = i % BOARD_SIZE;
  const out: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE) out.push(r * BOARD_SIZE + c);
    }
  }
  return out;
}

/** Precomputed adjacency, since the solver walks it constantly. */
export const ADJACENCY: readonly number[][] = Array.from({ length: CELL_COUNT }, (_, i) =>
  neighbors(i),
);
