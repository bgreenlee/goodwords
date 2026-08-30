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

/** The word a round was named for, kept with the round it belonged to. */
export type PlayedBonus = {
  word: string;
  partOfSpeech: string;
  gloss: string;
  found: boolean;
};

export type PlayedGame = {
  round: number;
  board: string[];
  words: string[];
  score: number;
  total: number;
  possible: number;
  taught: TaughtWord[];
  /** Absent on rounds filed before the bonus word existed. */
  bonus?: PlayedBonus | null;
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
  /** This browser's own id, so a day of rounds adds up to one player. */
  id: string;
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

const NO_PROFILE: Profile = { id: "", name: "", welcomed: false, learned: [] };

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

function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function loadProfile(): Profile {
  // The first build kept name and learned words under one key.
  const legacy = read<Partial<Profile> | null>("goodwords.v1", null);
  const saved = read<Partial<Profile>>(PROFILE_KEY, legacy ?? {});
  const profile: Profile = {
    ...NO_PROFILE,
    ...saved,
    learned: Array.isArray(saved.learned) ? saved.learned : [],
    id: saved.id || newId(),
  };
  // A player who arrived before this existed gets an id now, and keeps it.
  if (profile.id !== saved.id) saveProfile(profile);
  return profile;
}

export function saveProfile(profile: Profile): void {
  write(PROFILE_KEY, profile);
}

export function loadGames(): PlayedGame[] {
  const games = read<PlayedGame[]>(GAMES_KEY, []);
  if (!Array.isArray(games)) return [];
  // Empty rounds are no longer filed, but a tab left open before that change will
  // have collected a run of them. Drop them on the way past.
  const played = games.filter((g) => Array.isArray(g?.words) && g.words.length > 0);
  if (played.length !== games.length) write(GAMES_KEY, played.slice(0, MAX_GAMES));
  return played.slice(0, MAX_GAMES);
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
