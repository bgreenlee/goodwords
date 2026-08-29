/** Big Boggle scoring. Words are 4+ letters; a Qu cell counts as two letters. */
export function scoreWord(word: string): number {
  const n = word.length;
  if (n < 4) return 0;
  if (n === 4) return 1;
  if (n === 5) return 2;
  if (n === 6) return 3;
  if (n === 7) return 5;
  return 11;
}
