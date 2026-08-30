/**
 * Everything the game remembers. No accounts in V0, so it is all this browser.
 *
 * Three keys rather than one: the in-progress round is rewritten on every word
 * found, and it should not drag the whole archive of past games through a JSON
 * round trip each time.
 */

export type TaughtWord = {
  lemma: string;
  word: string;
  partOfSpeech: string;
  gloss: string;
};

export type PlayedGame = {
  round: number;
  board: string[];
  words: string[];
  score: number;
  total: number;
  possible: number;
  taught: TaughtWord[];
  at: number;
};

/** The round being played, so a refresh does not throw it away. */
export type InProgress = {
  /** Identifies the exact board; a stored round only restores onto its own board. */
  key: string;
  board: string[];
  words: string[];
};

export type Profile = {
  name: string;
  /** Whether the welcome has been shown. A name alone cannot say so. */
  welcomed: boolean;
  /** Lemmas whose definition has been shown at least once. */
  learned: string[];
};

const PROFILE_KEY = "goodwords.profile";
const GAMES_KEY = "goodwords.games";
const PROGRESS_KEY = "goodwords.progress";
/** Enough to look back over a long sitting without crowding the quota. */
export const MAX_GAMES = 60;

const NO_PROFILE: Profile = { name: "", welcomed: false, learned: [] };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing, or the quota is full. Remembering is a nicety, and
    // failing to remember must never interrupt a game.
  }
}

export function loadProfile(): Profile {
  // The first build kept name and learned words under one key.
  const legacy = read<Partial<Profile> | null>("goodwords.v1", null);
  const saved = read<Partial<Profile>>(PROFILE_KEY, legacy ?? {});
  return {
    ...NO_PROFILE,
    ...saved,
    learned: Array.isArray(saved.learned) ? saved.learned : [],
  };
}

export function saveProfile(profile: Profile): void {
  write(PROFILE_KEY, profile);
}

export function loadGames(): PlayedGame[] {
  const games = read<PlayedGame[]>(GAMES_KEY, []);
  return Array.isArray(games) ? games.slice(0, MAX_GAMES) : [];
}

/** Newest first, capped, one entry per round. */
export function addGame(games: PlayedGame[], game: PlayedGame): PlayedGame[] {
  const next = [game, ...games.filter((g) => g.round !== game.round)].slice(0, MAX_GAMES);
  write(GAMES_KEY, next);
  return next;
}

export function loadProgress(): InProgress | null {
  const saved = read<InProgress | null>(PROGRESS_KEY, null);
  return saved && Array.isArray(saved.words) && Array.isArray(saved.board) ? saved : null;
}

export function saveProgress(progress: InProgress | null): void {
  if (progress === null) {
    try {
      localStorage.removeItem(PROGRESS_KEY);
    } catch {
      /* nothing to do */
    }
    return;
  }
  write(PROGRESS_KEY, progress);
}
