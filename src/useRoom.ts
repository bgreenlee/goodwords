import { useEffect, useRef, useState } from "react";
import type { Board as BoardCells } from "./game/dice";
import type { LeaderRow, ServerMessage } from "./net/protocol";

/** "solo" means the game is playable but nothing is being scored against others. */
export type RoomStatus = "connecting" | "live" | "solo";

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

export function useRoom(name: string): Room {
  const [snap, setSnap] = useState<Snapshot>(EMPTY);
  const socket = useRef<WebSocket | null>(null);
  const nameRef = useRef(name);

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

      ws.addEventListener("open", () => {
        attempt = 0;
        ws.send(JSON.stringify({ t: "hello", name: nameRef.current }));
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
              // Scores reset with the board; do not show the last round's ranking.
              top: msg.round === prev.round ? prev.top : [],
              rank: msg.round === prev.round ? prev.rank : 0,
            };
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
        // Keep playing: the board and the dictionary are already here.
        setSnap((prev) => ({ ...prev, status: "solo", board: null, round: null, top: [] }));
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

  function submit(word: string) {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "word", w: word }));
  }

  return { ...snap, submit };
}
