import { useEffect, useRef, useState } from "react";
import type { Board as BoardCells } from "./game/dice";
import { roundAt } from "./game/schedule";
import type { BonusClue, DailyRow, LeaderRow, ServerMessage, Tally } from "./net/protocol";

/**
 * "solo" means no room was ever reached, so the board comes from the clock.
 * "reconnecting" means one was: keep playing that board, and expect to be scored
 * again shortly. Dropping back to a solo board mid-round would change the board.
 */
export type RoomStatus = "connecting" | "live" | "reconnecting" | "solo";

export type Room = {
  status: RoomStatus;
  /** Server clock minus this browser's clock; added before reading the schedule. */
  offsetMs: number;
  round: number | null;
  board: BoardCells | null;
  top: LeaderRow[];
  players: number;
  rank: number;
  you: string | null;
  /** Standings across the last day, which only move when a round finishes. */
  daily: DailyRow[];
  /** The round's bonus word, given as its definition. Null when there is none. */
  bonus: BonusClue | null;
  /** How the last finished round settled, once everyone's words were in. */
  tally: Tally | null;
  /** Set to the bonus word the moment the room confirms you found it. */
  bonusHit: string | null;
  submit: (word: string) => void;
};

type Snapshot = Omit<Room, "submit">;

const EMPTY: Snapshot = {
  status: "connecting",
  offsetMs: 0,
  round: null,
  board: null,
  top: [],
  players: 0,
  rank: 0,
  you: null,
  daily: [],
  bonus: null,
  tally: null,
  bonusHit: null,
};

// Back off on repeated failures, but keep trying: a player who started solo should
// be pulled into the live game as soon as the connection comes back.
const RETRY_MS = [500, 1000, 2000, 5000, 10_000];

/**
 * How long to wait for a board before starting a solo game. A refused connection
 * fails immediately, but one that hangs — a captive portal, a proxy that swallows
 * the upgrade — would otherwise leave the player staring at nothing.
 */
const JOIN_TIMEOUT_MS = 2500;

/** How long to wait for the room's own board before asking for one. */
const DEAL_NUDGE_MS = 1500;

export function useRoom(name: string, id: string): Room {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const socket = useRef<WebSocket | null>(null);
  const nameRef = useRef(name);
  const idRef = useRef(id);
  idRef.current = id;

  useEffect(() => {
    nameRef.current = name;
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "name", name }));
  }, [name]);

  useEffect(() => {
    let closed = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/play`);
      socket.current = ws;

      // Start solo if no board arrives in time; a later board still promotes us.
      const giveUp = setTimeout(() => {
        setSnap((prev) => (prev.status === "connecting" ? { ...prev, status: "solo" } : prev));
      }, JOIN_TIMEOUT_MS);
      // A reconnect that lands on the same round keeps its board; only a genuinely
      // new board resets play, which the round check below decides.

      ws.addEventListener("open", () => {
        attempt = 0;
        ws.send(JSON.stringify({ t: "hello", name: nameRef.current, id: idRef.current }));
      });

      ws.addEventListener("message", (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }
        clearTimeout(giveUp);
        setSnap((prev) => {
          if (msg.t === "board") {
            return {
              ...prev,
              status: "live",
              // Measured before any render work, so it reflects network skew only.
              offsetMs: msg.now - Date.now(),
              round: msg.round,
              board: msg.board,
              you: msg.you,
              players: msg.players,
              bonus: msg.bonus,
              bonusHit: msg.round === prev.round ? prev.bonusHit : null,
              // A new board makes the last round's settlement history.
              tally: msg.round === prev.round ? prev.tally : null,
              // Scores reset with the board; do not show the last round's ranking.
              top: msg.round === prev.round ? prev.top : [],
              rank: msg.round === prev.round ? prev.rank : 0,
            };
          }
          if (msg.t === "ok" && msg.bonus) {
            return { ...prev, bonusHit: msg.w };
          }
          if (msg.t === "tally") {
            const { t: _t, ...tally } = msg;
            return { ...prev, tally };
          }
          if (msg.t === "daily") {
            return { ...prev, daily: msg.top };
          }
          if (msg.t === "lb") {
            return { ...prev, top: msg.top, players: msg.players, rank: msg.rank };
          }
          return prev;
        });
      });

      const dropped = () => {
        clearTimeout(giveUp);
        if (closed || socket.current !== ws) return;
        socket.current = null;
        setSnap((prev) =>
          prev.board
            ? // Hold the dealt board. A deploy restarts the room and every socket
              // with it; swapping the board would end everyone's round.
              { ...prev, status: "reconnecting", top: [], players: 0, rank: 0 }
            : { ...prev, status: "solo", board: null, round: null, top: [] },
        );
        retry = setTimeout(connect, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]);
      };
      ws.addEventListener("close", dropped);
      ws.addEventListener("error", dropped);
    }

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
    };
  }, []);

  // The room pushes a board at every boundary. If one goes astray the browser
  // would otherwise sit on "dealing the next board" for good, so it asks.
  useEffect(() => {
    if (snap.status !== "live" || snap.round === null) return;
    const id = setInterval(() => {
      const ws = socket.current;
      if (ws?.readyState !== WebSocket.OPEN) return;
      if (roundAt(Date.now() + snap.offsetMs).round > snap.round!) {
        ws.send(JSON.stringify({ t: "deal" }));
      }
    }, DEAL_NUDGE_MS);
    return () => clearInterval(id);
  }, [snap.status, snap.round, snap.offsetMs]);

  function submit(word: string) {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "word", w: word }));
  }

  return { ...snap, submit };
}
