import { findPath } from "./solver";
import { TEACH_ZIPF_MAX, TEACH_ZIPF_MIN } from "./vocab";
import type { Board } from "./dice";

/** [word, "partOfSpeech|gloss"], longest first, then rarest. */
export type BonusCandidate = [string, string];

export type BonusWord = {
  word: string;
  partOfSpeech: string;
  gloss: string;
};

/**
 * The round's bonus word: the longest word the board can spell that is also worth
 * knowing. The list arrives sorted, so the first one the board can form wins and
 * the scan stops. A pure function of the board, so the room and the browser agree
 * without having to say so.
 */
export function pickBonus(board: Board, candidates: BonusCandidate[]): BonusWord | null {
  for (const [word, entry] of candidates) {
    if (!findPath(board, word)) continue;
    const split = entry.indexOf("|");
    return {
      word,
      partOfSpeech: entry.slice(0, split),
      gloss: entry.slice(split + 1),
    };
  }
  return null;
}

/**
 * The same choice made from a board already solved, which is what the browser has
 * when it is playing alone. Longest first, then rarest — the rule the candidate
 * list is sorted by.
 */
export function bonusFromSolution(
  solution: Iterable<string>,
  defs: Record<string, string>,
  lemmaOf: Record<string, string>,
  zipf: (word: string) => number,
  minLength = 6,
  band: [number, number] = [TEACH_ZIPF_MIN, TEACH_ZIPF_MAX],
): BonusWord | null {
  let best: BonusWord | null = null;
  let bestZipf = Infinity;
  for (const word of solution) {
    if (word.length < minLength) continue;
    const lemma = lemmaOf[word] ?? word;
    const entry = defs[lemma];
    if (!entry) continue;
    const z = zipf(lemma);
    if (z < band[0] || z > band[1]) continue;
    if (best && word.length < best.word.length) continue;
    if (best && word.length === best.word.length && z >= bestZipf) continue;
    const split = entry.indexOf("|");
    best = { word, partOfSpeech: entry.slice(0, split), gloss: entry.slice(split + 1) };
    bestZipf = z;
  }
  return best;
}
