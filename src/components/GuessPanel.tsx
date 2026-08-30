import { scoreWord } from "../game/scoring";

type Props = {
  guesses: string[];
  score: number;
  onHover: (word: string | null) => void;
};

export function GuessPanel({ guesses, score, onHover }: Props) {
  return (
    <section className="panel">
      <header className="panel__head">
        <h2>Your words</h2>
        <span className="panel__count">
          {guesses.length} · {score} pt
        </span>
      </header>
      {guesses.length === 0 ? (
        <p className="muted">Words you find will appear here.</p>
      ) : (
        <ul className="guesses" onMouseLeave={() => onHover(null)}>
          {guesses.map((w) => (
            <li key={w} onPointerMove={() => onHover(w)}>
              <span className="guesses__word">{w}</span>
              <span className="guesses__pts">{scoreWord(w)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
