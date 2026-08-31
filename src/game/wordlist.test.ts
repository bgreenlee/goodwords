import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, onTestFinished, test } from "vitest";
import { Trie } from "./trie";
import { teachableFrom } from "./vocab";

/** The words on one of the hand-kept lists, without comments or blanks. */
function list(name: string): string[] {
  return readFileSync(`wordlist/${name}`, "utf8")
    .split("\n")
    .map((line) => line.split("#")[0].trim().split("|")[0].trim().toLowerCase())
    .filter(Boolean);
}

const words = readFileSync("public/data/words.txt", "utf8").split("\n");
const freq = readFileSync("public/data/freq.bin");
const vocab = JSON.parse(readFileSync("public/data/vocab.json", "utf8")) as {
  defs: Record<string, string>;
  lemmaOf: Record<string, string>;
};
const bonus = JSON.parse(readFileSync("public/data/bonus.json", "utf8")) as [string, string][];
const dictionary = new Set(words);
const bonusWords = new Set(bonus.map(([word]) => word));
const rank = new Map(words.map((word, i) => [word, freq[i]] as const));
const gameData = { trie: new Trie(words), zipf: (word: string) => (rank.get(word) ?? 0) / 32 };
const excluded = list("excluded.txt");
const added = list("added.txt");

describe("hand-kept word lists", () => {
  test("the lists are applied to the shipped data", () => {
    // Guards against a rebuild that regenerated the data and skipped the lists.
    expect(excluded.length).toBeGreaterThan(0);
    for (const word of excluded) expect(dictionary.has(word)).toBe(false);
    for (const word of added) expect(dictionary.has(word)).toBe(true);
  });

  test("an excluded word cannot be played in any form", () => {
    for (const word of excluded) {
      for (const form of [word, `${word}s`, `${word}es`]) {
        expect(dictionary.has(form)).toBe(false);
      }
    }
  });

  test("an excluded word is never taught in the missed-words column", () => {
    for (const word of excluded) {
      expect(vocab.defs[word]).toBeUndefined();
      expect(vocab.lemmaOf[word]).toBeUndefined();
      // Nor reachable as the root of some other missed word.
      expect(Object.values(vocab.lemmaOf)).not.toContain(word);
      const taught = teachableFrom([word], [], vocab, gameData, 10);
      expect(taught.map((entry) => entry.word)).not.toContain(word);
    }
  });

  test("an excluded word can never name a round", () => {
    for (const word of excluded) expect(bonusWords.has(word)).toBe(false);
  });

  test("removing words leaves the data self-consistent", () => {
    expect(freq.length).toBe(words.length);
    expect(words).toEqual([...words].sort());
    expect(new Set(words).size).toBe(words.length);
    expect(words.every((word) => word.length >= 4)).toBe(true);
    // Every inflection still points at a headword that has a definition.
    for (const lemma of Object.values(vocab.lemmaOf)) {
      expect(vocab.defs[lemma]).toBeDefined();
    }
  });

  test("the client trie rejects an excluded word", () => {
    for (const word of excluded) expect(gameData.trie.has(word)).toBe(false);
  });

  // Someone acting on a report pastes the form they were shown, which is often an
  // inflection. Excluding it has to reach the headword, not just that spelling.
  test.skipIf(!hasPython())("excluding an inflection also excludes its headword", () => {
    expect(vocab.lemmaOf["mooches"], "test needs a live inflection").toBe("mooch");
    const { out } = runOn({ excluded: "mooches\n", added: "" });

    const after = new Set(readFileSync(join(out, "words.txt"), "utf8").split("\n"));
    for (const form of ["mooches", "mooch", "mooched", "mooching"]) {
      expect(after.has(form), `${form} should be gone`).toBe(false);
    }
    const afterVocab = JSON.parse(readFileSync(join(out, "vocab.json"), "utf8"));
    expect(afterVocab.defs["mooch"]).toBeUndefined();
  });

  // Exercises the script itself against a scratch copy of the data, so both halves
  // of the mechanism are covered even while added.txt is empty.
  test.skipIf(!hasPython())(
    "adding a word makes it playable, and teachable with a definition",
    () => {
      const { out, rerun } = runOn({
        excluded: "# none\n",
        added: "sneakle\nfnordling | noun | a thing invented for a test\n",
      });

      const after = readFileSync(join(out, "words.txt"), "utf8").split("\n");
      const afterFreq = readFileSync(join(out, "freq.bin"));
      const afterVocab = JSON.parse(readFileSync(join(out, "vocab.json"), "utf8"));
      const afterBonus = JSON.parse(readFileSync(join(out, "bonus.json"), "utf8")) as [
        string,
        string,
      ][];

      // Both are playable; the data stays sorted and aligned around them.
      expect(after).toContain("sneakle");
      expect(after).toContain("fnordling");
      expect(after).toEqual([...after].sort());
      expect(afterFreq.length).toBe(after.length);

      // Only the one given a definition is taught or can name a round.
      expect(afterVocab.defs["fnordling"]).toBe("noun|a thing invented for a test");
      expect(afterVocab.defs["sneakle"]).toBeUndefined();
      expect(afterBonus.some(([word]) => word === "fnordling")).toBe(true);
      expect(afterBonus.some(([word]) => word === "sneakle")).toBe(false);

      // Running it twice is a no-op, not a duplicate.
      rerun();
      const twice = readFileSync(join(out, "words.txt"), "utf8").split("\n");
      expect(twice).toEqual(after);
    },
  );
});

/**
 * The script-level tests need python3. Skipping locally is a convenience; on CI a
 * missing interpreter must fail, or these tests would silently disappear from a
 * green build.
 */
function hasPython(): boolean {
  if (process.env.CI) return true;
  return spawnSync("python3", ["--version"]).status === 0;
}

/** Run the script over a scratch copy of the shipped data with the given lists. */
function runOn(lists: { excluded: string; added: string }) {
  const dir = mkdtempSync(join(tmpdir(), "wordlist-"));
  const out = join(dir, "data");
  const listDir = join(dir, "lists");
  mkdirSync(listDir);
  cpSync("public/data", out, { recursive: true });
  writeFileSync(join(listDir, "excluded.txt"), lists.excluded);
  writeFileSync(join(listDir, "added.txt"), lists.added);
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const rerun = () => {
    const run = spawnSync("python3", [
      "-c",
      "import sys; sys.path.insert(0, 'tools'); import wordlist; " +
        `wordlist.apply(${JSON.stringify(out)}, ${JSON.stringify(listDir)})`,
    ]);
    expect(run.status, run.stderr?.toString()).toBe(0);
  };
  rerun();
  return { out, rerun };
}
