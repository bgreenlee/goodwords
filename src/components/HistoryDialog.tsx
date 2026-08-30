import { useEffect, useState } from "react";
import { Board } from "./Board";
import { findPath } from "../game/solver";
import { scoreWord } from "../game/scoring";
import type { PlayedGame } from "../storage";

type Props = {
  games: PlayedGame[];
  onClose: () => void;
};

function when(at: number): string {
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function HistoryDialog({ games, onClose }: Props) {
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const game = games[selected];

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="history-title">
      <div className="sheet sheet--wide">
        <header className="sheet__head">
          <h2 id="history-title" className="sheet__title">
            Your games
          </h2>
          <button type="button" className="sheet__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        {games.length === 0 ? (
          <p className="muted">
            Boards you finish are kept here, so you can come back and look them over.
          </p>
        ) : (
          <div className="past">
            <ol className="past__list">
              {games.map((g, i) => (
                <li key={g.round}>
                  <button
                    type="button"
                    className={`past__item${i === selected ? " past__item--on" : ""}`}
                    onClick={() => setSelected(i)}
                  >
                    <span className="past__score">{g.score}</span>
                    <span className="past__meta">
                      {g.words.length} of {g.possible} words
                    </span>
                    <span className="past__when">{when(g.at)}</span>
                  </button>
                </li>
              ))}
            </ol>

            <div className="past__detail">
              <div className="past__board">
                {/* Lit the same way the round ended, so the board reads the same. */}
                <Board
                  cells={game.board}
                  path={game.bonus ? (findPath(game.board, game.bonus.word) ?? []) : []}
                />
                {game.bonus && (
                  <div className={`clue${game.bonus.found ? " clue--found" : ""}`}>
                    <span className="clue__tag">
                      {game.bonus.found ? "Bonus word" : "Bonus word, missed"}
                    </span>
                    <span
                      className={game.bonus.found ? "clue__word" : "clue__word clue__word--missed"}
                    >
                      {game.bonus.word}
                    </span>
                    <span className="clue__gloss">{game.bonus.gloss}</span>
                  </div>
                )}
              </div>
              <div className="past__cols">
                <section>
                  <h3 className="past__h">
                    You found {game.words.length} · {game.score} of {game.total} points
                  </h3>
                  {game.words.length === 0 ? (
                    <p className="muted">No words that round.</p>
                  ) : (
                    <ul className="guesses">
                      {game.words.map((w) => (
                        <li key={w}>
                          <span className="guesses__word">{w}</span>
                          <span className="guesses__pts">{scoreWord(w)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <h3 className="past__h">Worth knowing</h3>
                  {game.taught.length === 0 ? (
                    <p className="muted">Nothing new on that board.</p>
                  ) : (
                    <ul className="vocab">
                      {game.taught.map((t) => (
                        <li key={t.lemma} className="vocab__item">
                          <div className="vocab__head">
                            <span className="vocab__word">{t.lemma}</span>
                            <span className="vocab__pos">{t.partOfSpeech}</span>
                          </div>
                          <p className="vocab__gloss">{t.gloss}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
