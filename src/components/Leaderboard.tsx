import type { LeaderRow } from "../net/protocol";
import type { RoomStatus } from "../useRoom";

type Props = {
  status: RoomStatus;
  rows: LeaderRow[];
  players: number;
  you: string | null;
  rank: number;
};

export function Leaderboard({ status, rows, players, you, rank }: Props) {
  return (
    <section className="panel" data-room={status}>
      <header className="panel__head">
        <h2>Leaderboard</h2>
        <span className="panel__count">
          {status === "live"
            ? `${players} playing`
            : status === "connecting"
              ? "connecting…"
              : "offline"}
        </span>
      </header>

      {status !== "live" ? (
        <p className="muted">
          {status === "connecting"
            ? "Finding the other players…"
            : "You’re playing on your own — the board is yours alone until the connection comes back."}
        </p>
      ) : rows.length === 0 ? (
        <p className="muted">Nobody has scored yet this round.</p>
      ) : (
        <ol className="ladder">
          {rows.map((row, i) => (
            <li
              key={row.id}
              className={row.id === you ? "ladder__row ladder__row--you" : "ladder__row"}
            >
              <span className="ladder__rank">{i + 1}</span>
              <span className="ladder__name">{row.name}</span>
              <span className="ladder__words">{row.words}</span>
              <span className="ladder__score">{row.score}</span>
            </li>
          ))}
        </ol>
      )}

      {status === "live" && rank > rows.length && (
        <p className="panel__hint">
          You’re {rank} of {players}.
        </p>
      )}
    </section>
  );
}
