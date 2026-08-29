/** Local-only history. No accounts in V0, so everything lives in this browser. */
const KEY = "goodwords.v1";

export type History = {
  name: string;
  roundsPlayed: number;
  bestScore: number;
  /** Lemmas whose definition this player has been shown at least once. */
  learned: string[];
};

const EMPTY: History = { name: "", roundsPlayed: 0, bestScore: 0, learned: [] };

export function loadHistory(): History {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function saveHistory(h: History): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    // Private browsing or a full quota; history is a nicety, not a requirement.
  }
}
