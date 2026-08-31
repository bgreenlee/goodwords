import { findPath } from "./solver";
import { TEACH_ZIPF_MAX, TEACH_ZIPF_MIN } from "./band";
import type { Board } from "./dice";

/** [word, "partOfSpeech|gloss"], longest first, then rarest. */
export type BonusCandidate = [string, string];

export type BonusWord = {
  word: string;
  partOfSpeech: string;
  gloss: string;
};

const BLANK = "________";

// Words carrying no clue of their own, so blanking around them can leave a line
// that reads like a definition while saying nothing.
const EMPTY = new Set(
  (
    "a an the of or and to in on at by for from with as is are was were be been being that " +
    "this these those it its his her their our your my no not any some such other one two " +
    "into over under than then which who whom whose what when where while very more most " +
    "much many each both all usually especially typically often sometimes"
  ).split(" "),
);

/** Two words look like the same word when they open the same way. */
const sameStem = (a: string, b: string) =>
  a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5);

/**
 * Blank the answer out of its own clue.
 *
 * WordNet often names the word it is defining — "the mantissa is .808" — which
 * hands over a word the round is asking you to find. Relatives count too, since
 * "in a detrimental manner" gives up "detrimentally" just as plainly. Matching on
 * a shared opening blanks the occasional innocent word, which only makes a clue
 * harder; letting the answer through would make the round pointless.
 */
export function redactClue(word: string, lemma: string, gloss: string): string {
  const hidden = gloss.replace(/[A-Za-z]+/g, (token) => {
    const low = token.toLowerCase();
    if (low === word || low === lemma || sameStem(low, word) || sameStem(low, lemma)) {
      return BLANK;
    }
    return token;
  });
  return hidden.replace(new RegExp(`(?:${BLANK}[\\s-]*){2,}`, "g"), `${BLANK} `).trim();
}

/** True when a blanked clue still says enough to hunt by. */
export function usableClue(gloss: string): boolean {
  const words = gloss.toLowerCase().match(/[a-z]+/g) ?? [];
  return words.filter((word) => word.length > 2 && !EMPTY.has(word)).length >= 3;
}

/** The clue for a word, or null when blanking the answer left nothing to go on. */
function clueFor(word: string, lemma: string, entry: string): BonusWord | null {
  const split = entry.indexOf("|");
  const raw = entry.slice(split + 1);
  const gloss = redactClue(word, lemma, raw);
  // Only a clue that lost something can have been emptied by losing it. A short
  // definition that never named its answer is a fine clue — "a small fragment"
  // asks little of the reader but gives nothing away.
  if (gloss !== raw && !usableClue(gloss)) return null;
  return { word, partOfSpeech: entry.slice(0, split), gloss };
}

/**
 * The round's bonus word: the longest word the board can spell that is also worth
 * knowing. The list arrives sorted, so the first one the board can form wins and
 * the scan stops. A pure function of the board, so the room and the browser agree
 * without having to say so.
 */
export function pickBonus(
  board: Board,
  candidates: BonusCandidate[],
  lemmaOf: Record<string, string> = {},
): BonusWord | null {
  for (const [word, entry] of candidates) {
    if (!findPath(board, word)) continue;
    const clue = clueFor(word, lemmaOf[word] ?? word, entry);
    // A word whose clue collapses to nothing is no use as a hunt, so read on.
    if (clue) return clue;
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
    const clue = clueFor(word, lemma, entry);
    if (!clue) continue;
    best = clue;
    bestZipf = z;
  }
  return best;
}
