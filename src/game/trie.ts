/**
 * Trie over the dictionary. The solver needs prefix pruning — without it, walking
 * 25 cells with 8-way adjacency is combinatorially hopeless.
 *
 * Stored as flat typed arrays: `child[node * 26 + letter]` is the child node id, or
 * 0 for absent. Node 0 doubles as "no child" because the root can never be a child.
 */
const A = 97;

export class Trie {
  private child: Int32Array;
  private terminal: Uint8Array;
  private size = 1;

  constructor(words: string[]) {
    // Upper bound on nodes; trimmed after the build.
    const cap = words.reduce((n, w) => n + w.length, 1) + 1;
    this.child = new Int32Array(cap * 26);
    this.terminal = new Uint8Array(cap);
    for (const word of words) this.insert(word);
    this.child = this.child.slice(0, this.size * 26);
    this.terminal = this.terminal.slice(0, this.size);
  }

  private insert(word: string): void {
    let node = 0;
    for (let i = 0; i < word.length; i++) {
      const c = word.charCodeAt(i) - A;
      if (c < 0 || c > 25) return;
      const slot = node * 26 + c;
      let next = this.child[slot];
      if (next === 0) {
        next = this.size++;
        this.child[slot] = next;
      }
      node = next;
    }
    this.terminal[node] = 1;
  }

  /** Follow one letter from `node`; returns -1 if no such edge exists. */
  step(node: number, letter: number): number {
    const next = this.child[node * 26 + letter];
    return next === 0 ? -1 : next;
  }

  isWord(node: number): boolean {
    return this.terminal[node] === 1;
  }

  /** Whole-word lookup, for validating a typed guess. */
  has(word: string): boolean {
    let node = 0;
    for (let i = 0; i < word.length; i++) {
      node = this.step(node, word.charCodeAt(i) - A);
      if (node < 0) return false;
    }
    return this.isWord(node);
  }

  get nodeCount(): number {
    return this.size;
  }
}
