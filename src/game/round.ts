import { scoreWord } from "./scoring";

export type RoundResults = {
  round: number;
  /** Valid words on the board the player did not find. */
  missed: string[];
  found: string[];
  score: number;
  total: number;
};

/** Score one finished round: what was found, what was missed, and what it was worth. */
export function scoreRound(round: number, solution: Set<string>, guesses: string[]): RoundResults {
  const found = new Set(guesses);
  let score = 0;
  let total = 0;
  const missed: string[] = [];
  for (const word of solution) {
    const points = scoreWord(word);
    total += points;
    if (found.has(word)) score += points;
    else missed.push(word);
  }
  return { round, missed, found: guesses, score, total };
}
