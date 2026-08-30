import { useState } from "react";
import { labelRows } from "../names";
import type { DailyRow, LeaderRow } from "../net/protocol";
import type { RoomStatus } from "../useRoom";

type Props = {
  status: RoomStatus;
  rows: LeaderRow[];
  daily: DailyRow[];
  players: number;
  you: string | null;
  /** This browser's own id, which is how it appears in the day's standings. */
  yourId: string;
  rank: number;
};

type Tab = "now" | "day";

export function Leaderboard({ status, rows, daily, players, you, yourId, rank }: Props) {
  const [tab, setTab] = useState<Tab>("now");
  const showing: Tab = status === "live" ? tab : "now";
  // Two people may well pick the same name; only say which is which if it shows.
  const liveNames = labelRows(rows);
  const dayNames = labelRows(daily);

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

      {status === "live" && (
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={showing === "now"}
            className={`tabs__tab${showing === "now" ? " tabs__tab--on" : ""}`}
            onClick={() => setTab("now")}
          >
            This round
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={showing === "day"}
            className={`tabs__tab${showing === "day" ? " tabs__tab--on" : ""}`}
            onClick={() => setTab("day")}
          >
            Last 24 hours
          </button>
        </div>
      )}

      {status !== "live" ? (
        <p className="muted">
          {status === "connecting"
            ? "Finding the other players…"
            : "You’re playing on your own — the board is yours alone until the connection comes back."}
        </p>
      ) : showing === "day" ? (
        daily.length === 0 ? (
          <p className="muted">No finished rounds yet today.</p>
        ) : (
          <ol className="ladder">
            {daily.map((row, i) => (
              <li
                key={row.id}
                className={row.id === yourId ? "ladder__row ladder__row--you" : "ladder__row"}
              >
                <span className="ladder__rank">{i + 1}</span>
                <span className="ladder__name">{dayNames.get(row.id)}</span>
                <span className="ladder__words" title={`best round ${row.best}`}>
                  {row.rounds}
                  {row.rounds === 1 ? " game" : " games"}
                </span>
                <span className="ladder__score">{row.total}</span>
              </li>
            ))}
          </ol>
        )
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
              <span className="ladder__name">{liveNames.get(row.id)}</span>
              <span className="ladder__words">{row.words}</span>
              <span className="ladder__score">{row.score}</span>
            </li>
          ))}
        </ol>
      )}

      {status === "live" && showing === "now" && rank > rows.length && (
        <p className="panel__hint">
          You’re {rank} of {players}.
        </p>
      )}
    </section>
  );
}
