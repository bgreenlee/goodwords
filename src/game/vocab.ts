import { scoreWord } from "./scoring";
import type { GameData, Vocab } from "./data";

/**
 * The band of word frequencies worth teaching. Above it, everybody already knows
 * the word; below it, the word is a Scrabble-list artifact nobody needs. This is
 * the main knob to turn after playing a few rounds.
 */
export const TEACH_ZIPF_MIN = 1.8;
export const TEACH_ZIPF_MAX = 4.2;
export const TEACH_LIMIT = 8;

export type Teachable = {
  /** The word as it appeared on the board. */
  word: string;
  /** The dictionary headword, which may differ when `word` is an inflection. */
  lemma: string;
  partOfSpeech: string;
  gloss: string;
  points: number;
};

/**
 * Pick the words from `missed` most worth learning: highest scoring first, and
 * among equals the least common, since those are likeliest to be new.
 */
export function teachableFrom(
  missed: Iterable<string>,
  vocab: Vocab,
  data: GameData,
  limit = TEACH_LIMIT,
): Teachable[] {
  // Many board words reduce to one headword; keep the highest-scoring spelling.
  const byLemma = new Map<string, string>();
  for (const word of missed) {
    const lemma = vocab.lemmaOf[word] ?? word;
    const entry = vocab.defs[lemma];
    if (!entry) continue;
    const z = data.zipf(lemma);
    if (z < TEACH_ZIPF_MIN || z > TEACH_ZIPF_MAX) continue;
    const prev = byLemma.get(lemma);
    if (!prev || scoreWord(word) > scoreWord(prev)) byLemma.set(lemma, word);
  }

  return [...byLemma]
    .sort(([la, wa], [lb, wb]) => scoreWord(wb) - scoreWord(wa) || data.zipf(la) - data.zipf(lb))
    .slice(0, limit)
    .map(([lemma, word]) => {
      const [partOfSpeech, gloss] = vocab.defs[lemma].split("|");
      return { word, lemma, partOfSpeech, gloss, points: scoreWord(word) };
    });
}
