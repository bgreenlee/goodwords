/**
 * The band of word frequencies the game treats as worth knowing. Above it,
 * everyone already knows the word; below it, the word is Scrabble-list residue.
 *
 * It lives on its own because both the definitions column and the bonus word need
 * it, and the worker needs the bonus word — pulling it out of vocab.ts keeps the
 * browser-only modules out of the worker's type graph.
 *
 * tools/build_data.py holds the same numbers, and engine.test.ts fails if the
 * shipped candidate list drifts outside them.
 */
export const TEACH_ZIPF_MIN = 1.8;
export const TEACH_ZIPF_MAX = 4.2;
