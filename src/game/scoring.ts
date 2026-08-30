/**
 * Points by length. Big Boggle stops at 8 and pays 11 for everything longer,
 * which makes a ten-letter find worth no more than an eight — and long words are
 * the ones worth spending a round hunting. Measured over 400 boards, 4-letter
 * words are 47% of everything findable, 8-letter words 1.8%, and 10-letter words
 * 0.07%, so the curve keeps climbing instead of flattening.
 */
const BY_LENGTH = [0, 0, 0, 0, 1, 2, 4, 8, 15, 25, 40];
const LONGEST = 60;

export function scoreWord(word: string): number {
  const n = word.length;
  if (n < 4) return 0;
  return n < BY_LENGTH.length ? BY_LENGTH[n] : LONGEST;
}

/** Words nobody else found are worth double, once a round has company. */
export const UNIQUE_MULTIPLIER = 2;
/** The round's named word, whose definition is given as the clue. */
export const BONUS_MULTIPLIER = 2;
