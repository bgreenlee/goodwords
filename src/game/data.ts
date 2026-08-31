import { Trie } from "./trie";

export type Vocab = {
  /** lemma -> "partOfSpeech|gloss" */
  defs: Record<string, string>;
  /** inflection -> the lemma worth teaching */
  lemmaOf: Record<string, string>;
};

export type GameData = {
  trie: Trie;
  /** Zipf frequency, 0 when the word never appears in the reference corpus. */
  zipf: (word: string) => number;
};

const BASE = `${import.meta.env.BASE_URL}data`;
/** Changes whenever the data changes, so a stale copy is never reused. */
const V = `?v=${__DATA_VERSION__}`;

export async function loadDictionary(): Promise<GameData> {
  const [wordsText, freqBuf] = await Promise.all([
    fetch(`${BASE}/words.txt${V}`).then((r) => r.text()),
    fetch(`${BASE}/freq.bin${V}`).then((r) => r.arrayBuffer()),
  ]);
  const words = wordsText.split("\n");
  const freq = new Uint8Array(freqBuf);
  const rank = new Map(words.map((w, i) => [w, freq[i]]));
  return {
    trie: new Trie(words),
    zipf: (word) => (rank.get(word) ?? 0) / 32,
  };
}

/**
 * Definitions are only needed once a round ends, so this is fetched in the
 * background while the first game is already being played.
 */
export function loadVocab(): Promise<Vocab> {
  return fetch(`${BASE}/vocab.json${V}`).then((r) => r.json());
}
