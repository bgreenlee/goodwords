import { useEffect, useRef, useState } from "react";
import { BonusClue } from "./components/BonusClue";
import { Board, reachableFrom } from "./components/Board";
import { GuessPanel } from "./components/GuessPanel";
import { Leaderboard } from "./components/Leaderboard";
import { VocabPanel } from "./components/VocabPanel";
import { CELL_COUNT, rollBoard, type Board as BoardCells } from "./game/dice";
import { loadDictionary, loadVocab, type GameData, type Vocab } from "./game/data";
import { formatClock } from "./game/schedule";
import { scoreRound, type RoundResults } from "./game/round";
import { bonusFromSolution, type BonusWord } from "./game/bonus";
import { BONUS_MULTIPLIER, scoreWord } from "./game/scoring";
import { findPath, solveBoard } from "./game/solver";
import { teachableFrom } from "./game/vocab";
import { HistoryDialog } from "./components/HistoryDialog";
import { TopBar } from "./components/TopBar";
import { Welcome } from "./components/Welcome";
import {
  addGame,
  loadGames,
  loadProfile,
  loadProgress,
  saveProfile,
  saveProgress,
  type PlayedGame,
  type Profile,
} from "./storage";
import { useRoom } from "./useRoom";
import { useKeepBoardVisible, usePlaySpace } from "./usePlaySpace";
import { useRound } from "./useRound";

type Round = { round: number; key: string; board: BoardCells; solution: Set<string> };

const BLANK_BOARD: BoardCells = Array(CELL_COUNT).fill("");
const NO_WORDS: Set<string> = new Set();

/** Touch devices raise a keyboard on focus, which is not something to do unasked. */
const isTouch = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches;

/**
 * How long a word's path stays lit before fading back. Shorter on a phone: taps
 * come faster than typing, and a highlight still fading from the last word while
 * the next is being tapped reads as the game lagging behind.
 */
const HIGHLIGHT_MS = isTouch ? 320 : 700;
/** A refusal is a shorter beat still — it is a correction, not a reward. */
const REJECT_MS = isTouch ? 380 : 550;
/** Pace for replaying restored words to the room, under its ten-a-second limit. */
const RESYNC_MS = 160;

/** A stored round only resumes onto the board it was played on. */
const boardsMatch = (a: string[], b: string[]) =>
  a.length === b.length && a.every((cell, i) => cell === b[i]);

export default function App() {
  usePlaySpace();
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
  const [profile, setProfile] = useState<Profile>(loadProfile);
  const [games, setGames] = useState<PlayedGame[]>(loadGames);
  const [dialog, setDialog] = useState<"welcome" | "help" | "games" | null>(
    profile.welcomed ? null : "welcome",
  );
  const room = useRoom(profile.name, profile.id);
  const { round, phase, remainingMs } = useRound(room.offsetMs);
  const [guesses, setGuesses] = useState<string[]>([]);
  const [entry, setEntry] = useState("");
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const [path, setPath] = useState<number[]>([]);
  const [rejected, setRejected] = useState<number[]>([]);
  const [traced, setTraced] = useState<number[] | null>(null);
  const [rotation, setRotation] = useState(0);
  /** Set when we are playing alone and know the bonus word ourselves. */
  const [soloHit, setSoloHit] = useState<string | null>(null);
  /** Cells tapped so far. Empty means the word is being typed instead. */
  const [selection, setSelection] = useState<number[]>([]);
  /**
   * The same list, readable at once. A finger lifting ends a word, and that can
   * happen before React has re-rendered with the last letter, so the handler
   * cannot rely on the value it closed over.
   */
  const selectionRef = useRef<number[]>([]);
  const [results, setResults] = useState<RoundResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useKeepBoardVisible(inputRef);

  // Live games use the board the server dealt, which nobody can precompute. Solo,
  // the board comes from the round number so the game still works offline.
  //
  // Never fall back to the solo board while connected. Our clock reaches the next
  // round slightly before the server's board arrives, and playing the clock-derived
  // board in that gap means playing a board no other player has, on which every
  // word would be refused. Wait for the deal instead.
  const connected = room.status === "live" || room.status === "reconnecting";
  const dealt = connected && room.round === round ? room.board : null;
  // The board is part of the key, not just the round: if the room ever deals a
  // different board for the same round, the screen must follow it rather than
  // quietly keep playing the old one.
  const key = dealt
    ? `dealt:${round}:${dealt.join("")}`
    : room.status === "solo"
      ? `solo:${round}`
      : null;

  const cache = useRef<Round | null>(null);
  if (key !== null && cache.current?.key !== key) {
    const rolled = dealt ?? rollBoard(round);
    cache.current = { round, key, board: rolled, solution: solveBoard(rolled, data.trie) };
  }
  const board = cache.current?.board ?? BLANK_BOARD;
  const solution = cache.current?.solution ?? NO_WORDS;
  // Between rounds we hold the last board on screen but must not accept words on it.
  const waiting = key === null || cache.current?.key !== key;

  // Words found before a refresh, waiting to be put back on their own board.
  const interrupted = useRef(loadProgress());
  const resync = useRef<string[]>([]);
  const draining = useRef(false);

  // Clear play whenever the board changes — a new round, or a solo player being
  // promoted into a live game part way through one.
  const [seenKey, setSeenKey] = useState<string | null>(null);
  if (key !== null && seenKey !== key) {
    setSeenKey(key);
    // Read without clearing, so nothing here depends on how often React re-runs a
    // render pass. The key check is what stops an old round resuming onto a new
    // board, so consuming the ref would buy nothing.
    const saved = interrupted.current;
    const resumable =
      saved && saved.key === key && boardsMatch(saved.board, board) ? saved.words : [];
    setGuesses(resumable);
    setEntry("");
    setFeedback(null);
    setPath([]);
    setRejected([]);
    setTraced(null);
    setSoloHit(null);
    setSelection([]);
    selectionRef.current = [];
  }

  // The break is the reveal: score the board that was just played. If the board
  // changed in this same render there is nothing to score — the clock jumped, as a
  // sleeping laptop waking during a later break, or a new board has just arrived.
  const [seenPhase, setSeenPhase] = useState(phase);
  if (seenPhase !== phase) {
    setSeenPhase(phase);
    if (phase === "break" && key !== null && seenKey === key) {
      setResults(scoreRound(round, board, solution, guesses));
    }
  }

  // The word the round is named for. Live, the room sends only the definition and
  // tells us the word when it is found; alone, we work it out ourselves.
  // Working this out walks the whole solution, which is hundreds of words. It only
  // changes with the board, so it must not be redone on every tap and every tick
  // of the clock.
  const soloBonusCache = useRef<{ key: string; bonus: BonusWord | null } | null>(null);
  const wantSoloBonus = room.status === "solo" && vocab !== null && key !== null;
  if (wantSoloBonus && soloBonusCache.current?.key !== key) {
    soloBonusCache.current = {
      key: key!,
      bonus: bonusFromSolution(solution, vocab!.defs, vocab!.lemmaOf, data.zipf),
    };
  }
  const soloBonus = wantSoloBonus ? (soloBonusCache.current?.bonus ?? null) : null;
  const clue =
    room.bonus ??
    (soloBonus
      ? {
          partOfSpeech: soloBonus.partOfSpeech,
          gloss: soloBonus.gloss,
          length: soloBonus.word.length,
        }
      : null);

  // Alone we spot it ourselves; live the room confirms it.
  const bonusFound = soloHit ?? room.bonusHit;

  const taught =
    results && vocab ? teachableFrom(results.missed, results.found, vocab, data) : null;
  const tracingThisBoard = results?.round === round;

  // The word the pointer is resting on, so a repeat of the same hover does not
  // re-render and an accepted word can cancel a stale one.
  const tracedWord = useRef<string | null>(null);

  function trace(word: string | null) {
    if (tracedWord.current === word) return;
    tracedWord.current = word;
    setTraced(word ? findPath(board, word) : null);
  }

  // File the finished round: the board, what was found, and what was worth
  // learning. Definitions can arrive after the round ends, so this waits for them
  // rather than filing a game with an empty vocabulary list.
  const filed = useRef<Set<number>>(new Set());
  useEffect(() => {
    if (!results || !taught || filed.current.has(results.round)) return;
    filed.current.add(results.round);
    // A round nobody played is not a game. A tab left open would otherwise fill the
    // history with empty boards and count vocabulary that nobody was there to read.
    if (results.found.length === 0) return;

    setProfile((prev) => {
      const learned = new Set(prev.learned);
      for (const t of taught) learned.add(t.lemma);
      const next: Profile = { ...prev, learned: [...learned] };
      saveProfile(next);
      return next;
    });
    setGames((prev) =>
      addGame(prev, {
        round: results.round,
        board: results.board,
        words: results.found,
        score: results.score,
        total: results.total,
        possible: results.found.length + results.missed.length,
        taught: taught.map((t) => ({
          lemma: t.lemma,
          word: t.word,
          partOfSpeech: t.partOfSpeech,
          gloss: t.gloss,
        })),
        bonus:
          revealed && clue
            ? {
                word: revealed,
                partOfSpeech: clue.partOfSpeech,
                gloss: clue.gloss,
                found: bonusFound === revealed,
              }
            : null,
        at: Date.now(),
      }),
    );
  }, [results, taught]);

  // Typing should just work, without having to click the box first, and space
  // turns the board the way you would turn the physical one — except while a
  // dialog is up, where those keys belong to the dialog.
  const dialogOpen = useRef(false);
  dialogOpen.current = dialog !== null;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (dialogOpen.current) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const inTextField = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA";

      if (event.key === " ") {
        // A space is never part of a word, and the only other text fields live in
        // dialogs, which have already returned above.
        event.preventDefault();
        setRotation((r) => (r + 1) % 4);
        return;
      }
      if (inTextField) return;

      const field = inputRef.current;
      if (!field || field.disabled) return;
      if (/^[a-z]$/i.test(event.key)) {
        // Focus the box and let the browser deliver the character to it. Appending
        // by hand as well means two writers: with quick typing the manual append
        // can land after several native ones and the letters come out reordered.
        chooseCells([]);
        field.focus();
      } else if (event.key === "Backspace") {
        event.preventDefault();
        // Backspace undoes the last tap when a word is being tapped out.
        if (selectionRef.current.length > 0) chooseCells(selectionRef.current.slice(0, -1));
        setEntry((prev) => prev.slice(0, -1));
      } else if (event.key === "Enter") {
        field.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (key === null || waiting) return;
    saveProgress(guesses.length > 0 ? { key, board, words: guesses } : null);
  }, [guesses, key, waiting, board]);

  // Every new connection starts at zero on the room's side — a first join, a
  // refresh, or the room being restarted by a deploy. Play our words back to it so
  // the leaderboard catches up, spaced out so the rate limit does not refuse them.
  const wasLive = useRef(false);
  useEffect(() => {
    const live = room.status === "live";
    const justJoined = live && !wasLive.current;
    wasLive.current = live;
    if (!justJoined || guesses.length === 0) return;
    resync.current = [...guesses].reverse();
    if (draining.current) return;
    draining.current = true;
    const step = () => {
      const word = resync.current.shift();
      if (!word) {
        draining.current = false;
        return;
      }
      room.submit(word);
      setTimeout(step, RESYNC_MS);
    };
    step();
  }, [room.status, guesses, room]);

  useEffect(() => {
    if (path.length === 0) return;
    const id = setTimeout(() => setPath([]), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [path]);

  useEffect(() => {
    if (rejected.length === 0) return;
    const id = setTimeout(() => setRejected([]), REJECT_MS);
    return () => clearTimeout(id);
  }, [rejected]);

  const worth = (w: string) => scoreWord(w) * (w === bonusFound ? BONUS_MULTIPLIER : 1);
  const score = guesses.reduce((n, w) => n + worth(w), 0);
  // Until the room answers we do not know whose board this is. Showing the solo
  // board first would swap it under the player a moment later, on every load.
  const playing = phase === "playing" && !waiting;
  // Once the round is over the bonus word is named, so show where it was — the
  // one word everybody was looking for is worth seeing on the board.
  const revealed = playing ? null : (room.tally?.bonusWord ?? soloBonus?.word ?? null);
  const revealedPath = revealed ? findPath(board, revealed) : null;

  // The word as tapped out, with a Qu tile counting for both its letters.
  const tapped = selection.map((cell) => board[cell].toLowerCase()).join("");

  function chooseCells(next: number[]) {
    selectionRef.current = next;
    setSelection(next);
  }

  function tapTile(cell: number) {
    if (!playing) return;
    setEntry("");
    const prev = selectionRef.current;
    // Going back takes a letter off. Tapping the last one again is the tapped way
    // of saying it; drawing back onto the one before is the drawn way, since a
    // finger never re-enters the letter it is already on.
    if (prev[prev.length - 1] === cell || prev[prev.length - 2] === cell) {
      return chooseCells(prev.slice(0, -1));
    }
    const reachable = reachableFrom(prev);
    if (reachable !== null && !reachable.has(cell)) return;
    chooseCells([...prev, cell]);
  }

  /** A word drawn in one movement is finished when the finger comes up. */
  function finishDrawn() {
    const cells = selectionRef.current;
    if (cells.length === 0) return;
    submit(cells.map((cell) => board[cell].toLowerCase()).join(""), cells);
  }

  /**
   * `viaCells` is the route the player actually tapped. Without it the flash is
   * drawn from findPath, which returns the first route it finds — often a
   * different way of spelling the same word, which is disconcerting to watch
   * after you have just traced one yourself.
   */
  function submit(raw: string, viaCells?: number[]) {
    const word = raw.trim().toLowerCase();
    setEntry("");
    chooseCells([]);
    if (!word) return;

    // A refusal shows on the board as well as in words. The letters are where the
    // player is looking, and a line of text under them is easy to miss.
    const route = viaCells?.length ? viaCells : findPath(board, word);
    const refuse = (text: string) => {
      setFeedback({ text, ok: false });
      setRejected(route ?? []);
      setPath([]);
    };

    if (word.length < 4) return refuse("Four letters minimum");
    if (guesses.includes(word)) return refuse(`Already found ${word}`);
    if (!data.trie.has(word)) return refuse(`${word} isn’t in the dictionary`);
    const cells = route;
    if (!cells) return refuse(`${word} isn’t on this board`);

    // Alone we know the word; live the room confirms it, and either way the flash
    // and the doubled points land at once.
    const isBonus = soloBonus ? soloBonus.word === word : false;
    if (isBonus) setSoloHit(word);
    setGuesses((prev) => [word, ...prev]);
    room.submit(word);
    // The word just accepted is what the player is looking for. Any hover still
    // standing is stale — the list is about to shift under the pointer anyway.
    tracedWord.current = null;
    setTraced(null);
    setRejected([]);
    setPath(cells);
    setFeedback({
      text: isBonus
        ? `${word} +${scoreWord(word) * BONUS_MULTIPLIER} — the bonus word`
        : `${word} +${scoreWord(word)}`,
      ok: true,
    });
  }

  return (
    <div className="app">
      <TopBar
        name={profile.name}
        learned={profile.learned.length}
        games={games.length}
        onHelp={() => setDialog("help")}
        onHistory={() => setDialog("games")}
      />

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

          {waiting ? (
            <div className="board board--waiting">
              {room.status === "connecting" ? "Finding a game…" : "Dealing the next board…"}
            </div>
          ) : (
            <Board
              cells={board}
              // Hovering a word still wins: it is what the pointer is asking for.
              path={traced ?? (playing ? path : (revealedPath ?? []))}
              rejected={playing ? rejected : []}
              rotation={rotation}
              selection={playing ? selection : []}
              onTile={playing ? tapTile : undefined}
              onDrawn={playing ? finishDrawn : undefined}
            />
          )}

          <BonusClue clue={clue} found={bonusFound} reveal={revealed} />

          <form
            className="entry"
            onSubmit={(e) => {
              e.preventDefault();
              // Hand over the route as tapped, so the flash retraces it.
              submit(tapped || entry, tapped ? selection : undefined);
            }}
          >
            <input
              ref={inputRef}
              className="entry__input"
              // Tapping owns the box while a word is being tapped out, so the two
              // ways of building a word never disagree about what it is.
              readOnly={selection.length > 0}
              value={tapped || entry}
              disabled={!playing}
              autoFocus={!isTouch}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={playing ? "tap the letters, or type" : "next board starting…"}
              onChange={(e) => setEntry(e.target.value.replace(/[^a-zA-Z]/g, ""))}
            />
            {selection.length > 0 && (
              <>
                <button
                  type="button"
                  className="entry__btn"
                  aria-label="Undo the last letter"
                  onClick={() => chooseCells(selectionRef.current.slice(0, -1))}
                >
                  ⌫
                </button>
                <button type="submit" className="entry__btn entry__btn--go">
                  Enter
                </button>
              </>
            )}
          </form>

          {feedback && playing ? (
            <p className={`feedback${feedback.ok ? " feedback--ok" : ""}`}>{feedback.text}</p>
          ) : !playing && results ? (
            <p className="feedback feedback--ok">
              {room.tally?.round === results.round ? room.tally.score : results.score} of{" "}
              {results.total} points · {results.found.length} of{" "}
              {results.found.length + results.missed.length} words
              {room.tally?.round === results.round && room.tally.unique.length > 0 && (
                <>
                  {" · "}
                  <span title={room.tally.unique.join(", ")}>
                    {room.tally.unique.length} only you found +{room.tally.uniqueBonus}
                  </span>
                </>
              )}
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
            daily={room.daily}
            players={room.players}
            you={room.you}
            yourId={profile.id}
            rank={room.rank}
          />
        </div>
        <VocabPanel
          words={taught}
          loading={results !== null && vocab === null}
          learnedCount={profile.learned.length}
          onHover={tracingThisBoard ? trace : null}
        />
      </main>

      <footer className="credits">
        Definitions from <a href="https://wordnet.princeton.edu/">WordNet 3.1</a>, Princeton
        University. Word list: ENABLE, public domain.
      </footer>

      {(dialog === "welcome" || dialog === "help") && (
        <Welcome
          firstRun={dialog === "welcome"}
          name={profile.name}
          onStart={(name) => {
            const next: Profile = { ...profile, name, welcomed: true };
            setProfile(next);
            saveProfile(next);
            setDialog(null);
            inputRef.current?.focus();
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "games" && <HistoryDialog games={games} onClose={() => setDialog(null)} />}
    </div>
  );
}
