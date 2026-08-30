/**
 * Membership over the sorted word list by binary search on line offsets.
 *
 * The trie exists to prune prefixes while solving a whole board. Answering "is this
 * a word" needs no prefix walking, and the trie's 26-way node table costs tens of
 * megabytes — more than a Worker is allowed. This holds the raw text plus one
 * offset per line, a couple of megabytes in total.
 */
export class WordIndex {
  private readonly text: string;
  private readonly starts: Uint32Array;

  constructor(text: string) {
    const starts: number[] = [];
    for (let i = 0; i < text.length;) {
      starts.push(i);
      const nl = text.indexOf("\n", i);
      if (nl < 0) break;
      i = nl + 1;
    }
    this.text = text;
    this.starts = Uint32Array.from(starts);
  }

  get size(): number {
    return this.starts.length;
  }

  private at(line: number): string {
    const start = this.starts[line];
    const end = line + 1 < this.starts.length ? this.starts[line + 1] - 1 : this.text.length;
    return this.text.slice(start, end);
  }

  has(word: string): boolean {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const candidate = this.at(mid);
      if (candidate === word) return true;
      if (candidate < word) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }
}
