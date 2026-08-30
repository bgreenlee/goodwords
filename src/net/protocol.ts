/** Wire format shared by the browser and the Durable Object. */

export type LeaderRow = { id: string; name: string; score: number; words: number };

export type ClientMessage =
  { t: "hello"; name: string } | { t: "word"; w: string } | { t: "name"; name: string };

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
    }
  | { t: "ok"; w: string; points: number; score: number }
  | { t: "no"; w: string; reason: string }
  | { t: "board_ack"; round: number }
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
