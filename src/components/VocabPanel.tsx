import type { Teachable } from "../game/vocab";

type Props = {
  /** Null until the first round finishes. */
  words: Teachable[] | null;
  loading: boolean;
  learnedCount: number;
  /** Set when the board on screen is the one these words came from. */
  onHover: ((word: string | null) => void) | null;
};

export function VocabPanel({ words, loading, learnedCount, onHover }: Props) {
  return (
    <section className="panel">
      <header className="panel__head">
        <h2>Words you missed</h2>
        {learnedCount > 0 && <span className="panel__count">{learnedCount} seen</span>}
      </header>

      {words === null ? (
        <p className="muted">
          When the round ends, the words worth knowing that you didn&rsquo;t find will show up here
          with their definitions.
        </p>
      ) : loading ? (
        <p className="muted">Loading definitions…</p>
      ) : words.length === 0 ? (
        <p className="muted">Nothing new on that board — you found the good ones.</p>
      ) : (
        <>
          {onHover && <p className="panel__hint">Point at a word to trace it on the board.</p>}
          <ul className="vocab" onMouseLeave={() => onHover?.(null)}>
            {words.map((w) => (
              <li
                key={w.lemma}
                className={`vocab__item${onHover ? " vocab__item--traceable" : ""}`}
                onPointerMove={() => onHover?.(w.word)}
              >
                <div className="vocab__head">
                  {/* The word you missed, not its headword: you missed "mooches". */}
                  <span className="vocab__word">{w.word}</span>
                  <span className="vocab__pos">{w.partOfSpeech}</span>
                  <span className="vocab__pts">{w.points} pt</span>
                </div>
                {w.lemma !== w.word && <div className="vocab__via">from {w.lemma}</div>}
                <p className="vocab__gloss">{w.gloss}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
