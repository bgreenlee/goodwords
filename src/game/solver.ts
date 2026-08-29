import { ADJACENCY, CELL_COUNT, type Board } from "./dice";
import type { Trie } from "./trie";

const A = 97;

/** Lowercase letter codes a cell contributes; "QU" contributes two. */
function faceCodes(face: string): number[] {
  return face
    .toLowerCase()
    .split("")
    .map((ch) => ch.charCodeAt(0) - A);
}

/**
 * Every dictionary word formable on the board, as a set. Adjacent cells may be
 * walked in any of 8 directions, and no cell may be reused within one word.
 */
export function solveBoard(board: Board, trie: Trie, minLength = 4): Set<string> {
  const faces = board.map(faceCodes);
  const found = new Set<string>();
  const used = new Uint8Array(CELL_COUNT);
  const letters: number[] = [];

  function walk(cell: number, node: number): void {
    used[cell] = 1;
    let next = node;
    // A "Qu" cell contributes two letters, and the second can fail after the first
    // succeeded, so unwind exactly what this cell pushed rather than its face length.
    let pushed = 0;
    for (const code of faces[cell]) {
      const step = trie.step(next, code);
      if (step < 0) break;
      next = step;
      letters.push(code);
      pushed++;
    }

    if (pushed === faces[cell].length) {
      if (letters.length >= minLength && trie.isWord(next)) {
        found.add(String.fromCharCode(...letters.map((c) => c + A)));
      }
      for (const n of ADJACENCY[cell]) {
        if (!used[n]) walk(n, next);
      }
    }

    while (pushed-- > 0) letters.pop();
    used[cell] = 0;
  }

  for (let i = 0; i < CELL_COUNT; i++) walk(i, 0);
  return found;
}

/**
 * The cell path spelling `word`, or null if the board cannot form it. Used both to
 * validate a typed guess and to light up the board behind it.
 */
export function findPath(board: Board, word: string): number[] | null {
  const target = word.toLowerCase();
  const faces = board.map((f) => f.toLowerCase());
  const used = new Uint8Array(CELL_COUNT);
  const path: number[] = [];

  function walk(cell: number, at: number): boolean {
    const face = faces[cell];
    if (!target.startsWith(face, at)) return false;
    used[cell] = 1;
    path.push(cell);
    const next = at + face.length;
    if (next === target.length) return true;
    for (const n of ADJACENCY[cell]) {
      if (!used[n] && walk(n, next)) return true;
    }
    path.pop();
    used[cell] = 0;
    return false;
  }

  for (let i = 0; i < CELL_COUNT; i++) {
    if (walk(i, 0)) return path;
  }
  return null;
}
