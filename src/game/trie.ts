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
    // Grow as needed rather than allocating a bound of one node per letter: shared
    // prefixes mean only about a quarter of that is ever used, and the difference
    // is over a hundred megabytes.
    this.child = new Int32Array(1 << 16);
    this.terminal = new Uint8Array(1 << 12);
    for (const word of words) this.insert(word);
    this.child = this.child.slice(0, this.size * 26);
    this.terminal = this.terminal.slice(0, this.size);
  }

  private reserve(node: number): void {
    const needed = (node + 1) * 26;
    if (needed > this.child.length) {
      const grown = new Int32Array(Math.max(Math.ceil(this.child.length * 1.5), needed));
      grown.set(this.child);
      this.child = grown;
    }
    if (node + 1 > this.terminal.length) {
      const grown = new Uint8Array(Math.max(Math.ceil(this.terminal.length * 1.5), node + 1));
      grown.set(this.terminal);
      this.terminal = grown;
    }
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
        this.reserve(next);
        this.child[node * 26 + c] = next;
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
