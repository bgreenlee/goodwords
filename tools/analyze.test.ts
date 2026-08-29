// Diagnostic harness (run via vitest) that reports real-board statistics.
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { rollBoard, BOARD_SIZE } from "../src/game/dice";
import { Trie } from "../src/game/trie";
import { solveBoard, findPath } from "../src/game/solver";
import { scoreWord } from "../src/game/scoring";

const words = readFileSync("public/data/words.txt", "utf8").split("\n");
const freq = new Uint8Array(readFileSync("public/data/freq.bin"));
const vocab = JSON.parse(readFileSync("public/data/vocab.json", "utf8")) as {
  defs: Record<string, string>;
  lemmaOf: Record<string, string>;
};
const zipf = new Map(words.map((w, i) => [w, freq[i] / 32]));
const Z = (w: string) => zipf.get(w) ?? 0;

test("board analysis", () => {
  const trie = new Trie(words);
  const counts: number[] = [];
  const bandCounts: number[] = [];

  for (let k = 0; k < 6; k++) {
    const round = Math.floor(Date.now() / 210000) + k * 7;
    const board = rollBoard(round);
    const found = solveBoard(board, trie);
    counts.push(found.size);

    const grid = Array.from({ length: BOARD_SIZE }, (_, r) =>
      board
        .slice(r * BOARD_SIZE, (r + 1) * BOARD_SIZE)
        .map((c) => c.padEnd(2))
        .join(" "),
    ).join("\n  ");

    // Dedupe by lemma: many board words reduce to the same thing worth learning.
    const byLemma = new Map<string, string>();
    for (const w of found) {
      const lemma = vocab.lemmaOf[w] ?? w;
      if (!vocab.defs[lemma]) continue;
      const z = Z(lemma) || 99;
      if (z < 1.8 || z > 4.2) continue;
      const prev = byLemma.get(lemma);
      if (!prev || scoreWord(w) > scoreWord(prev)) byLemma.set(lemma, w);
    }
    bandCounts.push(byLemma.size);

    const ranked = [...byLemma].sort(
      ([la, wa], [lb, wb]) => scoreWord(wb) - scoreWord(wa) || Z(la) - Z(lb),
    );
    console.log(
      `\n=== round ${round} — ${found.size} words, ${byLemma.size} teachable ===\n  ${grid}`,
    );
    for (const [lemma, w] of ranked.slice(0, 6)) {
      const via = lemma === w ? "" : ` (via ${w})`;
      console.log(
        `    ${lemma}${via} — ${scoreWord(w)}pt z${Z(lemma).toFixed(1)} — ${vocab.defs[lemma]}`,
      );
    }
  }
  console.log(
    `\nwords/board ${Math.min(...counts)}–${Math.max(...counts)} | teachable/board ${Math.min(...bandCounts)}–${Math.max(...bandCounts)}`,
  );

  const b = rollBoard(1);
  const all = [...solveBoard(b, trie)];
  console.log(
    `findPath disagreements: ${all.filter((w) => !findPath(b, w)).length} of ${all.length}`,
  );
});
