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

/** Shake the dice and read the faces, drawing randomness from `next`. */
export function rollBoardWith(next: () => number): Board {
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

/**
 * Roll the board for a given round. Pure: the same round always yields the same
 * board, which is what lets solo players stay in sync without a server.
 *
 * Multiplayer cannot use this — a board derivable from the clock can be solved
 * before it is played. The server rolls a secret board and pushes it instead.
 */
export function rollBoard(round: number): Board {
  return rollBoardWith(rng(seedFrom(round)));
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

/**
 * Cell order for a board turned `quarters` × 90° clockwise: the entry at each
 * display position gives the index of the board cell that belongs there. Letters
 * stay upright — turning the grid is for seeing new words, not for reading sideways.
 */
export function rotatedOrder(quarters: number): number[] {
  let order = Array.from({ length: CELL_COUNT }, (_, i) => i);
  const turns = ((quarters % 4) + 4) % 4;
  for (let q = 0; q < turns; q++) {
    order = order.map((_, i) => {
      const row = Math.floor(i / BOARD_SIZE);
      const col = i % BOARD_SIZE;
      return order[(BOARD_SIZE - 1 - col) * BOARD_SIZE + row];
    });
  }
  return order;
}
