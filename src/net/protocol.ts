/** Wire format shared by the browser and the Durable Object. */

export type LeaderRow = { id: string; name: string; score: number; words: number };

/** A player's standing across every round they finished in the window. */
export type DailyRow = {
  id: string;
  name: string;
  total: number;
  rounds: number;
  best: number;
};

/** The round's bonus word, given as its definition. The word itself is the puzzle. */
export type BonusClue = {
  partOfSpeech: string;
  gloss: string;
  length: number;
};

/** How a finished round settled, once every player's words are known. */
export type Tally = {
  round: number;
  /** Your words that nobody else found. */
  unique: string[];
  /** What those were worth on top. */
  uniqueBonus: number;
  /** Revealed whether or not you found it. */
  bonusWord: string | null;
  gotBonus: boolean;
  /** Your final score for the round, bonuses included. */
  score: number;
};

export type ClientMessage =
  /** `id` is this browser's own, so a day of rounds adds up to one player. */
  | { t: "hello"; name: string; id?: string }
  | { t: "word"; w: string }
  | { t: "name"; name: string };

export type ServerMessage =
  /** Sent on connect and again at the start of every round. */
  | {
      t: "board";
      round: number;
      board: string[];
      /** Server clock, so the browser can correct for its own skew. */
      now: number;
      playEndsAt: number;
      roundEndsAt: number;
      you: string;
      /** Seeds the player count so a fresh join does not read "0 playing". */
      players: number;
      /** Null when the board cannot spell anything worth naming. */
      bonus: BonusClue | null;
    }
  | { t: "ok"; w: string; points: number; score: number; bonus?: true }
  | { t: "no"; w: string; reason: string }
  | { t: "board_ack"; round: number }
  | { t: "daily"; top: DailyRow[]; since: number }
  | ({ t: "tally" } & Tally)
  | {
      t: "lb";
      round: number;
      top: LeaderRow[];
      players: number;
      /** Your rank, 1-based; 0 when you have not scored yet. */
      rank: number;
      score: number;
    };

export const PLAYERS_SHOWN = 20;
export const DAY_MS = 24 * 60 * 60 * 1000;
