import { useEffect, useRef, useState } from "react";
import { Board } from "./components/Board";
import { GuessPanel } from "./components/GuessPanel";
import { Leaderboard } from "./components/Leaderboard";
import { VocabPanel } from "./components/VocabPanel";
import { rollBoard, type Board as BoardCells } from "./game/dice";
import { loadDictionary, loadVocab, type GameData, type Vocab } from "./game/data";
import { formatClock } from "./game/schedule";
import { scoreRound, type RoundResults } from "./game/round";
import { scoreWord } from "./game/scoring";
import { findPath, solveBoard } from "./game/solver";
import { teachableFrom } from "./game/vocab";
import { loadHistory, saveHistory, type History } from "./history";
import { useRoom } from "./useRoom";
import { useRound } from "./useRound";

type Round = { round: number; key: string; board: BoardCells; solution: Set<string> };

export default function App() {
  const [data, setData] = useState<GameData | null>(null);
  const [vocab, setVocab] = useState<Vocab | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadDictionary().then(setData, () => setError("Could not load the dictionary."));
    loadVocab().then(setVocab, () => setError("Could not load definitions."));
  }, []);

  if (error) return <div className="splash">{error}</div>;
  if (!data) return <div className="splash">Loading Good Words…</div>;
  return <Game data={data} vocab={vocab} />;
}

function Game({ data, vocab }: { data: GameData; vocab: Vocab | null }) {
  const [history, setHistory] = useState<History>(loadHistory);
  const room = useRoom(history.name);
  const { round, phase, remainingMs } = useRound(room.offsetMs);
  const [guesses, setGuesses] = useState<string[]>([]);
  const [entry, setEntry] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [path, setPath] = useState<number[]>([]);
  const [traced, setTraced] = useState<number[] | null>(null);
  const [rotation, setRotation] = useState(0);
  const [results, setResults] = useState<RoundResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Live games use the board the server dealt, which nobody can precompute. Solo,
  // the board comes from the round number so the game still works offline.
  const dealt = room.round === round ? room.board : null;
  const key = dealt ? dealt.join("") : `solo:${round}`;
  const cache = useRef<Round | null>(null);
  if (!cache.current || cache.current.key !== key) {
    const board = dealt ?? rollBoard(round);
    cache.current = { round, key, board, solution: solveBoard(board, data.trie) };
  }
  const { board, solution } = cache.current;

  // Clear the previous round's play when the clock rolls over.
  const [seenRound, setSeenRound] = useState(round);
  if (seenRound !== round) {
    setSeenRound(round);
    setGuesses([]);
    setEntry("");
    setFeedback(null);
    setPath([]);
    setTraced(null);
  }

  // The break is the reveal: score the round that just finished. If the round
  // changed in this same render the clock jumped — a sleeping laptop waking during
  // some later break — and this board was never played, so there is nothing to score.
  const [seenPhase, setSeenPhase] = useState(phase);
  if (seenPhase !== phase) {
    setSeenPhase(phase);
    if (phase === "break" && seenRound === round) {
      setResults(scoreRound(round, solution, guesses));
    }
  }

  const taught = results && vocab ? teachableFrom(results.missed, vocab, data) : null;
  const sameBoard = results?.round === round;

  function trace(word: string | null) {
    setTraced(word ? findPath(board, word) : null);
  }

  // Record what the player has been shown, so "words seen" survives a refresh.
  useEffect(() => {
    if (!taught || !results) return;
    setHistory((prev) => {
      const learned = new Set(prev.learned);
      for (const t of taught) learned.add(t.lemma);
      const next: History = {
        ...prev,
        learned: [...learned],
        roundsPlayed: prev.roundsPlayed + 1,
        bestScore: Math.max(prev.bestScore, results.score),
      };
      saveHistory(next);
      return next;
    });
    // Only fold in a given round once, however often this re-renders.
  }, [results?.round]); // eslint-disable-line react-hooks/exhaustive-deps

  // Typing should just work, without having to click the box first, and space
  // turns the board the way you would turn the physical one.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const inTextField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === " ") {
        // The name field is the one place a space should stay a space.
        if (target?.classList.contains("topbar__name")) return;
        event.preventDefault();
        setRotation((r) => (r + 1) % 4);
        return;
      }
      if (inTextField) return;

      const field = inputRef.current;
      if (!field || field.disabled) return;
      if (/^[a-z]$/i.test(event.key)) {
        event.preventDefault();
        field.focus();
        setEntry((prev) => prev + event.key.toLowerCase());
      } else if (event.key === "Backspace") {
        event.preventDefault();
        field.focus();
        setEntry((prev) => prev.slice(0, -1));
      } else if (event.key === "Enter") {
        field.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const score = guesses.reduce((n, w) => n + scoreWord(w), 0);
  // Until the room answers we do not know whose board this is. Showing the solo
  // board first would swap it under the player a moment later, on every load.
  const joining = room.status === "connecting";
  const playing = phase === "playing" && !joining;

  function submit(raw: string) {
    const word = raw.trim().toLowerCase();
    setEntry("");
    if (!word) return;
    if (word.length < 4) return setFeedback({ text: "Four letters minimum", ok: false });
    if (guesses.includes(word)) return setFeedback({ text: `Already found ${word}`, ok: false });
    if (!data.trie.has(word))
      return setFeedback({ text: `${word} isn’t in the dictionary`, ok: false });
    const cells = findPath(board, word);
    if (!cells) return setFeedback({ text: `${word} isn’t on this board`, ok: false });

    setGuesses((prev) => [word, ...prev]);
    room.submit(word);
    setPath(cells);
    setFeedback({ text: `${word} +${scoreWord(word)}`, ok: true });
  }

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Good Words <span className="topbar__tag">5×5 · 4 letters and up</span>
        </h1>
        <div className="topbar__right">
          <input
            className="topbar__name"
            value={history.name}
            placeholder="your name"
            maxLength={16}
            onChange={(e) => {
              const next = { ...history, name: e.target.value };
              setHistory(next);
              saveHistory(next);
            }}
          />
          <span className="topbar__stat">{history.learned.length} words seen</span>
        </div>
      </header>

      <main className="columns">
        <section className="panel panel--game">
          <div className={`clock${playing ? "" : " clock--break"}`}>
            <span className="clock__time">{formatClock(remainingMs)}</span>
            <span className="clock__label">
              {playing ? "left in this round" : "until the next board"}
            </span>
            <button
              type="button"
              className="clock__rotate"
              title="Turn the board (space)"
              aria-label="Turn the board"
              onClick={() => setRotation((r) => (r + 1) % 4)}
            >
              ⟳
            </button>
          </div>

          {joining ? (
            <div className="board board--waiting">Finding a game…</div>
          ) : (
            <Board cells={board} path={traced ?? (playing ? path : [])} rotation={rotation} />
          )}

          <form
            className="entry"
            onSubmit={(e) => {
              e.preventDefault();
              submit(entry);
            }}
          >
            <input
              ref={inputRef}
              className="entry__input"
              value={entry}
              disabled={!playing}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={playing ? "type a word, press enter" : "next board starting…"}
              onChange={(e) => setEntry(e.target.value.replace(/[^a-zA-Z]/g, ""))}
            />
          </form>

          {feedback && playing ? (
            <p className={`feedback${feedback.ok ? " feedback--ok" : ""}`}>{feedback.text}</p>
          ) : !playing && results ? (
            <p className="feedback feedback--ok">
              {results.score} of {results.total} points · {results.found.length} of{" "}
              {results.found.length + results.missed.length} words
            </p>
          ) : (
            <p className="feedback">&nbsp;</p>
          )}
        </section>

        <div className="stack">
          <GuessPanel guesses={guesses} score={score} onHover={trace} />
          <Leaderboard
            status={room.status}
            rows={room.top}
            players={room.players}
            you={room.you}
            rank={room.rank}
          />
        </div>
        <VocabPanel
          words={taught}
          loading={results !== null && vocab === null}
          learnedCount={history.learned.length}
          onHover={sameBoard ? trace : null}
        />
      </main>

      <footer className="credits">
        Definitions from <a href="https://wordnet.princeton.edu/">WordNet 3.1</a>, Princeton
        University. Word list: ENABLE, public domain.
      </footer>
    </div>
  );
}
