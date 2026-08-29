// How thin does the definitions column ever get? The average is not the risk.
import { readFileSync } from "node:fs";
import { test } from "vitest";
import { rollBoard } from "../src/game/dice";
import { solveBoard } from "../src/game/solver";
import { Trie } from "../src/game/trie";
import { teachableFrom, TEACH_LIMIT } from "../src/game/vocab";

test("teachable floor across many boards", () => {
  const words = readFileSync("public/data/words.txt", "utf8").split("\n");
  const freq = new Uint8Array(readFileSync("public/data/freq.bin"));
  const rank = new Map(words.map((w, i) => [w, freq[i]]));
  const data = { trie: new Trie(words), zipf: (w: string) => (rank.get(w) ?? 0) / 32 };
  const vocab = JSON.parse(readFileSync("public/data/vocab.json", "utf8"));

  const counts: number[] = [];
  const N = 2000;
  for (let r = 0; r < N; r++) {
    const board = rollBoard(r);
    // Nothing found, so this is the full supply of teachable words for the board.
    const all = teachableFrom(solveBoard(board, data.trie), vocab, data, 1000);
    counts.push(all.length);
  }
  counts.sort((a, b) => a - b);
  const pct = (p: number) => counts[Math.floor((counts.length - 1) * p)];
  const short = counts.filter((c) => c < TEACH_LIMIT).length;
  console.log(
    `\n${N} boards — min ${counts[0]}, p1 ${pct(0.01)}, p10 ${pct(0.1)}, median ${pct(0.5)}, max ${counts[counts.length - 1]}`,
  );
  console.log(`boards with fewer than ${TEACH_LIMIT} teachable words: ${short} (${((100 * short) / N).toFixed(2)}%)`);
});
