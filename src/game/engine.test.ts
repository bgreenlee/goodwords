import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BIG_BOGGLE_DICE, CELL_COUNT, rollBoard, neighbors } from "./dice";
import { roundAt, PLAY_MS, ROUND_MS } from "./schedule";
import { scoreWord } from "./scoring";
import { scoreRound } from "./round";
import { findPath, solveBoard } from "./solver";
import { Trie } from "./trie";

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
});

describe("scoring", () => {
  test("Big Boggle values, four letters and up", () => {
    expect(scoreWord("cat")).toBe(0);
    expect([4, 5, 6, 7, 8, 12].map((n) => scoreWord("a".repeat(n)))).toEqual([1, 2, 3, 5, 11, 11]);
  });
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

  test("missed is exactly the solution minus what was found", () => {
    const r = scoreRound(7, solution, ["cats", "banjos"]);
    expect(r.round).toBe(7);
    expect([...r.missed].sort()).toEqual(["quiet", "tramp"]);
    expect(r.found).toEqual(["cats", "banjos"]);
    expect(r.score).toBe(scoreWord("cats") + scoreWord("banjos"));
    expect(r.total).toBe([...solution].reduce((n, w) => n + scoreWord(w), 0));
  });

  test("a word the player found is never also reported as missed", () => {
    for (const guesses of [[], ["cats"], [...solution]]) {
      const r = scoreRound(0, solution, guesses);
      for (const g of guesses) expect(r.missed).not.toContain(g);
      expect(r.missed.length + guesses.length).toBe(solution.size);
      expect(r.score).toBeLessThanOrEqual(r.total);
    }
  });

  test("guesses that are not on the board cannot inflate the score", () => {
    // Only words in the solution count, however the guess list was populated.
    const r = scoreRound(0, solution, ["zebra", "cats"]);
    expect(r.score).toBe(scoreWord("cats"));
  });
});
