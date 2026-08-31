import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  BIG_BOGGLE_DICE,
  CELL_COUNT,
  rollBoard,
  neighbors,
  rotatedOrder,
  BOARD_SIZE,
} from "./dice";
import { roundAt, BREAK_MS, PLAY_MS, ROUND_MS } from "./schedule";
import { scoreWord } from "./scoring";
import { pickBonus, redactClue, usableClue } from "./bonus";
import { teachableFrom } from "./vocab";
import { TEACH_ZIPF_MAX, TEACH_ZIPF_MIN } from "./vocab";
import { labelRows } from "../names";
import { scoreRound } from "./round";
import { findPath, solveBoard } from "./solver";
import { Trie } from "./trie";
import { WordIndex } from "./wordindex";

const words = readFileSync("public/data/words.txt", "utf8").split("\n");
const trie = new Trie(words);

describe("dice", () => {
  test("the set is 25 dice of 6 faces with exactly one Qu", () => {
    expect(BIG_BOGGLE_DICE).toHaveLength(25);
    for (const die of BIG_BOGGLE_DICE) expect(die).toHaveLength(6);
    const qs = BIG_BOGGLE_DICE.join("")
      .split("")
      .filter((c) => c === "Q");
    expect(qs).toHaveLength(1);
    // No die carries both Q and U, since the Q face is always played as "Qu".
    expect(BIG_BOGGLE_DICE.some((d) => d.includes("Q") && d.includes("U"))).toBe(false);
  });

  test("a roll is deterministic in the round number", () => {
    expect(rollBoard(42)).toEqual(rollBoard(42));
    expect(rollBoard(42)).not.toEqual(rollBoard(43));
  });

  test("Q always appears as Qu", () => {
    for (let r = 0; r < 3000; r++) {
      for (const face of rollBoard(r)) expect(face === "QU" || face.length === 1).toBe(true);
    }
  });

  test("every board is a legal roll: each cell maps to a distinct die", () => {
    // Bipartite matching between cells and dice via augmenting paths.
    const canUse = (face: string, die: string) => die.includes(face === "QU" ? "Q" : face);

    for (let r = 0; r < 400; r++) {
      const board = rollBoard(r);
      const dieForCell = new Array<number>(CELL_COUNT).fill(-1);
      const cellForDie = new Array<number>(25).fill(-1);

      const augment = (cell: number, seen: boolean[]): boolean => {
        for (let d = 0; d < 25; d++) {
          if (seen[d] || !canUse(board[cell], BIG_BOGGLE_DICE[d])) continue;
          seen[d] = true;
          if (cellForDie[d] === -1 || augment(cellForDie[d], seen)) {
            cellForDie[d] = cell;
            dieForCell[cell] = d;
            return true;
          }
        }
        return false;
      };

      for (let c = 0; c < CELL_COUNT; c++) {
        expect(augment(c, new Array(25).fill(false))).toBe(true);
      }
    }
  });

  test("neighbors respect the grid edges", () => {
    expect(neighbors(0).sort((a, b) => a - b)).toEqual([1, 5, 6]);
    expect(neighbors(12)).toHaveLength(8);
    expect(neighbors(24).sort((a, b) => a - b)).toEqual([18, 19, 23]);
  });
});

describe("schedule", () => {
  test("splits each cycle into play then break", () => {
    expect(roundAt(0)).toEqual({ round: 0, phase: "playing", remainingMs: PLAY_MS });
    expect(roundAt(PLAY_MS - 1).phase).toBe("playing");
    expect(roundAt(PLAY_MS).phase).toBe("break");
    expect(roundAt(ROUND_MS - 1).phase).toBe("break");
    expect(roundAt(ROUND_MS).round).toBe(1);
  });

  test("remaining time never exceeds its phase", () => {
    for (let t = 0; t < ROUND_MS * 3; t += 997) {
      const s = roundAt(t);
      expect(s.remainingMs).toBeGreaterThan(0);
      expect(s.remainingMs).toBeLessThanOrEqual(
        s.phase === "playing" ? PLAY_MS : ROUND_MS - PLAY_MS,
      );
    }
  });

  // The browser tests wait for a round with enough play time left before they
  // start, and their time budgets are that wait plus the work. This is the wait's
  // ceiling, so a budget built on it holds wherever in the round a run begins.
  test("waiting for play time never takes longer than a break plus what it asks for", () => {
    const wait = (from: number, minMs: number) => {
      for (let t = from; t < from + 2 * ROUND_MS; t += 250) {
        const s = roundAt(t);
        if (s.phase === "playing" && s.remainingMs > minMs) return t - from;
      }
      throw new Error("never reached play time");
    };
    // Every value the browser tests pass, and then some, so adding a call site does
    // not quietly rest the budgets on an unchecked claim.
    for (let minMs = 5_000; minMs < PLAY_MS; minMs += 5_000) {
      let worst = 0;
      for (let from = 0; from < ROUND_MS; from += 250) {
        worst = Math.max(worst, wait(from, minMs));
      }
      expect(worst, `waiting for ${minMs}ms of play`).toBeLessThanOrEqual(BREAK_MS + minMs);
    }
  });
});

describe("scoring", () => {
  test("nothing under four letters", () => {
    expect(scoreWord("cat")).toBe(0);
    expect(scoreWord("")).toBe(0);
  });

  test("longer is always worth more, and it does not stop at eight", () => {
    const lengths = [4, 5, 6, 7, 8, 9, 10, 11, 14];
    const points = lengths.map((n) => scoreWord("a".repeat(n)));
    expect(points).toEqual([1, 2, 4, 8, 15, 25, 40, 60, 60]);
    // Big Boggle pays 11 for everything from eight up, so a ten-letter find was
    // worth no more than an eight. Each step now pays more than the last.
    for (let i = 1; i < 8; i++) expect(points[i]).toBeGreaterThan(points[i - 1]);
  });

  test("a long word beats padding out short ones", () => {
    const long = scoreWord("outclass");
    const short = 6 * scoreWord("bare");
    expect(long, "eight letters should beat six four-letter words").toBeGreaterThan(short);
  });
});

describe("the bonus word", () => {
  const bonusList = JSON.parse(readFileSync("public/data/bonus.json", "utf8")) as [
    string,
    string,
  ][];

  test("every candidate is a word the game would teach", () => {
    // The bonus word and the missed-words column have to agree on what is worth
    // knowing, or the round can be named for a word the column will not explain.
    const vocab = JSON.parse(readFileSync("public/data/vocab.json", "utf8")) as {
      defs: Record<string, string>;
      lemmaOf: Record<string, string>;
    };
    const freq = new Uint8Array(readFileSync("public/data/freq.bin"));
    const rank = new Map(words.map((w, i) => [w, freq[i]]));
    const z = (w: string) => (rank.get(w) ?? 0) / 32;

    for (let i = 0; i < bonusList.length; i += 97) {
      const [word] = bonusList[i];
      const lemma = vocab.lemmaOf[word] ?? word;
      expect(vocab.defs[lemma], `${word} has no definition`).toBeDefined();
      expect(z(lemma), `${word} sits outside the band`).toBeGreaterThanOrEqual(TEACH_ZIPF_MIN);
      expect(z(lemma), `${word} sits outside the band`).toBeLessThanOrEqual(TEACH_ZIPF_MAX);
    }
  });

  test("candidates are ordered longest first", () => {
    for (let i = 1; i < 500; i++) {
      expect(bonusList[i][0].length).toBeLessThanOrEqual(bonusList[i - 1][0].length);
    }
  });

  test("it is a word the board can actually spell, and worth knowing", () => {
    for (let r = 0; r < 40; r++) {
      const board = rollBoard(r);
      const bonus = pickBonus(board, bonusList);
      if (!bonus) continue;
      expect(findPath(board, bonus.word), `${bonus.word} on round ${r}`).not.toBeNull();
      expect(trie.has(bonus.word)).toBe(true);
      expect(bonus.word.length).toBeGreaterThanOrEqual(6);
      expect(bonus.gloss.length).toBeGreaterThan(3);
      // The clue must not contain the answer it is asking for.
      expect(bonus.gloss.toLowerCase()).not.toContain(bonus.word.toLowerCase());
    }
  });

  test("the clue never gives away the answer", () => {
    // "the mantissa is .808" is a real gloss, and a real answer handed over.
    expect(
      redactClue("mantissa", "mantissa", "in the expression log 643 = 2.808 the mantissa is .808"),
    ).toBe("in the expression log 643 = 2.808 the ________ is .808");
    // A relative gives it away just as plainly.
    expect(redactClue("detrimentally", "detrimental", "in a detrimental manner")).toBe(
      "in a ________ manner",
    );
    // A word that merely shares letters is left alone.
    expect(redactClue("mantissa", "mantissa", "a small fractional part")).toBe(
      "a small fractional part",
    );
    // Neighbouring mentions read as one gap rather than a row of them.
    expect(
      redactClue("logarithm", "logarithm", "the logarithm logarithmic scale of a number"),
    ).toBe("the ________ scale of a number");
  });

  test("a clue left saying nothing is not used", () => {
    expect(usableClue("in a ________ manner")).toBe(false);
    expect(usableClue("of or relating to ________")).toBe(false);
    expect(usableClue("a woman ________")).toBe(false);
    expect(usableClue("the positive fractional part of the representation of a logarithm")).toBe(
      true,
    );
  });

  // Proving nothing longer fits means trying every longer candidate against the
  // board, which is tens of thousands of paths per board. A handful of boards is
  // enough to catch the ordering being wrong.
  test("it is the longest such word on the board", () => {
    for (let r = 0; r < 6; r++) {
      const board = rollBoard(r);
      const bonus = pickBonus(board, bonusList);
      if (!bonus) continue;
      const longer = bonusList.filter(([w]) => w.length > bonus.word.length);
      for (const [w, entry] of longer) {
        if (!findPath(board, w)) continue;
        // A longer word is only passed over when blanking the answer out of its
        // own clue leaves nothing to hunt by.
        const raw = entry.slice(entry.indexOf("|") + 1);
        const gloss = redactClue(w, w, raw);
        expect(
          gloss !== raw && !usableClue(gloss),
          `${w} is longer than ${bonus.word} and has a clue`,
        ).toBe(true);
      }
    }
  }, 60_000);
});

describe("trie", () => {
  test("knows the dictionary and rejects non-words", () => {
    expect(trie.has("quiet")).toBe(true);
    expect(trie.has("nematode")).toBe(true);
    expect(trie.has("zzzz")).toBe(false);
    expect(trie.has("quie")).toBe(false); // a prefix is not a word
  });
});

describe("solver", () => {
  const board = "CATSLINEPORTMUDS".split("").concat("EARTHXYZBW".split("")).slice(0, 25);

  test("finds only words the board can spell", () => {
    const found = solveBoard(board, trie);
    for (const w of found) {
      expect(w.length).toBeGreaterThanOrEqual(4);
      expect(trie.has(w)).toBe(true);
      expect(findPath(board, w)).not.toBeNull();
    }
  });

  test("findPath agrees with the solver across many boards", () => {
    for (let r = 0; r < 60; r++) {
      const b = rollBoard(r);
      for (const w of solveBoard(b, trie)) {
        // A solved word must be real: the DFS shares one letter stack, and a
        // mismatched push/pop would emit a word the board cannot actually spell.
        expect(trie.has(w), `${w} on round ${r} is not a word`).toBe(true);
        const path = findPath(b, w);
        expect(path, `${w} on round ${r}`).not.toBeNull();
        expect(new Set(path).size).toBe(path!.length); // no cell reused
      }
    }
  });

  test("a Qu cell that half-matches leaves the letter stack intact", () => {
    // "q" extends the prefix but "qu" does not, so the cell must unwind its push.
    const board = ["S", "QU", "E", "N", "O", "R", ...Array(19).fill("Z")];
    const found = solveBoard(board, trie);
    for (const w of found) expect(trie.has(w)).toBe(true);
    expect(found.has("suenor")).toBe(false);
  });

  test("rejects words that need a cell twice", () => {
    // A board with a single A cannot spell a word needing two.
    const board = ["A", ...Array(24).fill("Z")];
    expect(findPath(board, "aaaa")).toBeNull();
  });

  test("spells through a Qu cell", () => {
    const board = ["QU", "I", "T", ...Array(22).fill("Z")];
    expect(findPath(board, "quit")).toEqual([0, 1, 2]);
    expect(solveBoard(board, trie).has("quit")).toBe(true);
  });

  test("every scheduled board is playable", () => {
    let worst = Infinity;
    for (let r = 0; r < 250; r++) worst = Math.min(worst, solveBoard(rollBoard(r), trie).size);
    expect(worst).toBeGreaterThan(20);
  });
});

describe("scoring a round", () => {
  const solution = new Set(["cats", "tramp", "banjos", "quiet"]);
  const BOARD = rollBoard(1);

  test("missed is exactly the solution minus what was found", () => {
    const r = scoreRound(7, BOARD, solution, ["cats", "banjos"]);
    expect(r.round).toBe(7);
    expect(r.board).toEqual(BOARD);
    expect([...r.missed].sort()).toEqual(["quiet", "tramp"]);
    expect(r.found).toEqual(["cats", "banjos"]);
    expect(r.score).toBe(scoreWord("cats") + scoreWord("banjos"));
    expect(r.total).toBe([...solution].reduce((n, w) => n + scoreWord(w), 0));
  });

  test("a word the player found is never also reported as missed", () => {
    for (const guesses of [[], ["cats"], [...solution]]) {
      const r = scoreRound(0, BOARD, solution, guesses);
      for (const g of guesses) expect(r.missed).not.toContain(g);
      expect(r.missed.length + guesses.length).toBe(solution.size);
      expect(r.score).toBeLessThanOrEqual(r.total);
    }
  });

  test("guesses that are not on the board cannot inflate the score", () => {
    // Only words in the solution count, however the guess list was populated.
    const r = scoreRound(0, BOARD, solution, ["zebra", "cats"]);
    expect(r.score).toBe(scoreWord("cats"));
  });
});

describe("rotation", () => {
  test("no turn is the identity, and four turns come back round", () => {
    const identity = Array.from({ length: CELL_COUNT }, (_, i) => i);
    expect(rotatedOrder(0)).toEqual(identity);
    expect(rotatedOrder(4)).toEqual(identity);
    expect(rotatedOrder(-1)).toEqual(rotatedOrder(3));
  });

  test("every turn shows all 25 cells exactly once", () => {
    for (let q = 0; q < 4; q++) {
      expect(new Set(rotatedOrder(q)).size).toBe(CELL_COUNT);
    }
  });

  test("a quarter turn clockwise puts the bottom-left cell top-left", () => {
    // Row-major, so cell 20 is the bottom-left corner of a 5x5 grid.
    expect(rotatedOrder(1)[0]).toBe(20);
    expect(rotatedOrder(1)[BOARD_SIZE - 1]).toBe(0);
  });

  test("turning preserves adjacency, so the same words stay findable", () => {
    for (let q = 0; q < 4; q++) {
      const order = rotatedOrder(q);
      const displayOf = new Map(order.map((cell, i) => [cell, i]));
      for (let cell = 0; cell < CELL_COUNT; cell++) {
        const before = neighbors(cell)
          .map((n) => displayOf.get(n)!)
          .sort((a, b) => a - b);
        const after = neighbors(displayOf.get(cell)!).sort((a, b) => a - b);
        expect(after).toEqual(before);
      }
    }
  });
});

describe("word index", () => {
  const text = readFileSync("public/data/words.txt", "utf8");
  const index = new WordIndex(text);

  test("holds every word in the list", () => {
    expect(index.size).toBe(words.length);
    for (const w of words) expect(index.has(w), w).toBe(true);
  });

  test("agrees with the trie, which is what makes them interchangeable", () => {
    const probes = [
      "quiet",
      "nematode",
      "zzzz",
      "quie",
      "aardvark",
      "a",
      "",
      "zymurgy",
      words[0],
      words.at(-1)!,
      words[Math.floor(words.length / 2)],
      // Neighbours of real words, which a sloppy binary search would confuse.
      words[100] + "x",
      words[100].slice(0, -1),
      "zzzzzzzz",
      "aaaa",
    ];
    for (const p of probes) expect(index.has(p), p).toBe(trie.has(p));
  });

  test("rejects words the list does not contain", () => {
    for (const w of ["reoilx", "qwertyui", "boggle" + "z"]) expect(index.has(w)).toBe(false);
  });
});

describe("duplicate names", () => {
  test("a name shown once is left exactly as chosen", () => {
    const labels = labelRows([
      { id: "a", name: "ada" },
      { id: "b", name: "grace" },
    ]);
    expect(labels.get("a")).toBe("ada");
    expect(labels.get("b")).toBe("grace");
  });

  test("a clash is tagged, and the tags differ", () => {
    const labels = labelRows([
      { id: "a", name: "brad" },
      { id: "b", name: "Brad" },
      { id: "c", name: "ada" },
    ]);
    expect(labels.get("c")).toBe("ada");
    expect(labels.get("a")).toMatch(/^brad #\w{1,2}$/);
    expect(labels.get("b")).toMatch(/^Brad #\w{1,2}$/);
    expect(labels.get("a")).not.toBe(labels.get("b"));
  });

  test("the tag is stable for an id, so it does not shuffle between rounds", () => {
    const rows = [
      { id: "player-one", name: "sam" },
      { id: "player-two", name: "sam" },
    ];
    expect(labelRows(rows).get("player-one")).toBe(
      labelRows([...rows].reverse()).get("player-one"),
    );
  });
});

describe("what the missed column teaches", () => {
  const vocab = JSON.parse(readFileSync("public/data/vocab.json", "utf8")) as {
    defs: Record<string, string>;
    lemmaOf: Record<string, string>;
  };
  const freq = new Uint8Array(readFileSync("public/data/freq.bin"));
  const rank = new Map(words.map((w, i) => [w, freq[i]]));
  const data = { trie, zipf: (w: string) => (rank.get(w) ?? 0) / 32 };

  test("a headword you already found is not explained back to you", () => {
    // Reported from play: found "mooch", missed "mooches", and was taught "mooch".
    expect(vocab.lemmaOf["mooches"]).toBe("mooch");

    const cold = teachableFrom(["mooches"], [], vocab, data);
    expect(cold.map((t) => t.lemma)).toContain("mooch");

    const alreadyKnown = teachableFrom(["mooches"], ["mooch"], vocab, data);
    expect(alreadyKnown.map((t) => t.lemma)).not.toContain("mooch");
  });

  test("the entry names the word you missed, and the root it comes from", () => {
    const [entry] = teachableFrom(["mooches"], [], vocab, data);
    expect(entry.word, "the headword shown should be what you missed").toBe("mooches");
    expect(entry.lemma, "the definition belongs to the root").toBe("mooch");
    expect(entry.gloss.length).toBeGreaterThan(3);
  });

  test("finding one inflection hides the rest of that word", () => {
    const missed = ["mooches", "mooched", "mooching"].filter((w) => trie.has(w));
    expect(missed.length).toBeGreaterThan(1);
    expect(teachableFrom(missed, ["mooch"], vocab, data)).toHaveLength(0);
  });
});
