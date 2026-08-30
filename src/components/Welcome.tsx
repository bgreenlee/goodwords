import { useEffect, useRef, useState } from "react";

type Props = {
  /** First run asks for a name and cannot be dismissed without one. */
  firstRun: boolean;
  name: string;
  onStart: (name: string) => void;
  onClose: () => void;
};

export function Welcome({ firstRun, name, onStart, onClose }: Props) {
  const [draft, setDraft] = useState(name);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  useEffect(() => {
    if (firstRun) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [firstRun, onClose]);

  const trimmed = draft.trim();
  const ready = trimmed.length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    onStart(trimmed);
  }

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
      <div className="sheet">
        <h2 id="welcome-title" className="sheet__title">
          Good Words
        </h2>
        <p className="sheet__lede">
          Find as many words as you can in three minutes. Then spend the break reading the
          definitions of the good ones you missed.
        </p>

        <dl className="rules">
          <dt>Making a word</dt>
          <dd>
            Join letters that touch, including diagonally. Four letters or more, and no letter twice
            in the same word. A <b>Qu</b> tile counts as both letters.
          </dd>

          <dt>Scoring</dt>
          <dd>
            <span className="rules__scores">
              <span>4 letters · 1</span>
              <span>5 · 2</span>
              <span>6 · 3</span>
              <span>7 · 5</span>
              <span>8+ · 11</span>
            </span>
          </dd>

          <dt>Everyone plays the same board</dt>
          <dd>
            A new board every three and a half minutes, on the clock. Whoever is here plays it with
            you.
          </dd>

          <dt>Two things worth knowing</dt>
          <dd>
            Just type — the box does not need clicking first. <b>Space</b> turns the board a quarter
            turn, which is a good way to spot words you are missing.
          </dd>
        </dl>

        <form className="sheet__form" onSubmit={submit}>
          <label className="sheet__label" htmlFor="welcome-name">
            {firstRun ? "What should we call you?" : "Your name"}
          </label>
          <div className="sheet__row">
            <input
              id="welcome-name"
              ref={field}
              className="sheet__input"
              value={draft}
              maxLength={16}
              autoComplete="off"
              placeholder="your name"
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" className="sheet__go" disabled={!ready}>
              {firstRun ? "Start playing" : "Done"}
            </button>
          </div>
          {firstRun && !ready && (
            <p className="sheet__hint">
              It shows on the leaderboard. Anything will do — there is no account.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
