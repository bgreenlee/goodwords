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
      for (const form of [word, ...inflectionsOf(word)]) {
        expect(dictionary.has(form), `${form} is a form of excluded ${word}`).toBe(false);
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

  // Adding a word should not mean listing every shape of it by hand, and the forms
  // have to be the right ones: an added form is playable, so a wrong guess is a
  // made-up word rather than a harmless miss.
  test.skipIf(!hasPython())("an added word brings its regular forms", () => {
    const { out } = runOn({
      excluded: "# none\n",
      added: [
        "mosh | verb | dance aggressively at a rock concert",
        "selfie | noun | a photograph you take of yourself",
        "blog | verb | write an online journal",
        "vape | verb | inhale vapour from an electronic cigarette",
        "",
      ].join("\n"),
    });
    const after = new Set(readFileSync(join(out, "words.txt"), "utf8").split("\n"));
    const has = (word: string) => after.has(word);

    // -es after sh, a doubled consonant after a short vowel, a dropped e before -ing.
    for (const word of ["mosh", "moshes", "moshed", "moshing"]) expect(has(word), word).toBe(true);
    for (const word of ["blog", "blogs", "blogged", "blogging"]) expect(has(word), word).toBe(true);
    for (const word of ["vape", "vapes", "vaped", "vaping"]) expect(has(word), word).toBe(true);

    // A noun gets its plural and no verb forms, and no rule invents a non-word.
    expect(has("selfies")).toBe(true);
    for (const word of ["selfied", "selfieing", "moshs", "bloged", "vapeing"]) {
      expect(has(word), `${word} is not a word`).toBe(false);
    }

    // A form points at the word it came from, so missing "moshing" teaches "mosh"
    // the way missing "mooches" teaches "mooch".
    const vocabAfter = JSON.parse(readFileSync(join(out, "vocab.json"), "utf8"));
    expect(vocabAfter.lemmaOf["moshing"]).toBe("mosh");
    expect(vocabAfter.defs["mosh"]).toBe("verb|dance aggressively at a rock concert");
    expect(vocabAfter.defs["moshing"], "a form has no definition of its own").toBeUndefined();

    // And it can name a round on the same terms as any other word: long enough,
    // and backed by its root's definition.
    const bonusAfter = new Map(
      (JSON.parse(readFileSync(join(out, "bonus.json"), "utf8")) as [string, string][]).map(
        ([word, entry]) => [word, entry],
      ),
    );
    expect(bonusAfter.get("moshing")).toBe("verb|dance aggressively at a rock concert");
    expect(bonusAfter.has("mosh"), "four letters is too short to name a round").toBe(false);
  });

  // Listing a word the dictionary already has replaces its definition, which is the
  // way to fix a gloss that is wrong or badly worded rather than lose the word.
  test.skipIf(!hasPython())(
    "adding a word already in the dictionary overrides its definition",
    () => {
      const { out } = runOn({
        excluded: "# none\n",
        added:
          "shrimp | noun | a totally made up definition for testing\nmooch | verb | an invented gloss for the root\n",
      });
      const words = readFileSync(join(out, "words.txt"), "utf8").split("\n");
      const after = JSON.parse(readFileSync(join(out, "vocab.json"), "utf8"));
      const afterBonus = new Map(
        (JSON.parse(readFileSync(join(out, "bonus.json"), "utf8")) as [string, string][]).map(
          ([word, entry]) => [word, entry],
        ),
      );

      expect(after.defs["shrimp"]).toBe("noun|a totally made up definition for testing");
      // A round's clue lives beside the word, so it has to be overridden too or the
      // clue and the vocabulary column would disagree.
      expect(afterBonus.get("shrimp")).toBe("noun|a totally made up definition for testing");
      // An inflection carries its headword's gloss, so it follows the override.
      expect(afterBonus.get("mooches")).toBe("verb|an invented gloss for the root");

      // Overriding is not a second entry.
      expect(words.filter((word) => word === "shrimp")).toHaveLength(1);
      expect(words).toEqual([...words].sort());
    },
  );

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
/**
 * Mirrors FLAGGED in tools/wordnet.py: markers that label the word itself a slur.
 * Deliberately does not match a gloss that merely mentions such language, because
 * "a disparaging remark" is the correct definition of "aspersion".
 */
const SLUR_MARKER =
  /\((?:ethnic slur|racial slur|slang|vulgar|obscene|offensive|disparaging|derogatory)|(?:offensive|disparaging|derogatory|obscene|insulting|pejorative)\s+(?:term|terms|name|names|word|words)\b|vulgar slang\b|term of disparagement|used (?:disparagingly|offensively)/i;

/** The definition only. WordNet appends quoted examples, which may mention usage. */
const definitionOf = (entry: string) => entry.split("|").slice(1).join("|").split(/;\s*"/)[0];

describe("the definitions the game shows", () => {
  test("none of them is a slur", () => {
    const bad = Object.entries(vocab.defs).filter(([, entry]) =>
      SLUR_MARKER.test(definitionOf(entry)),
    );
    expect(bad.map(([word]) => word)).toEqual([]);
  });

  test("no round can be named with a word whose clue is a slur", () => {
    const bad = bonus.filter(([, entry]) => SLUR_MARKER.test(definitionOf(entry)));
    expect(bad.map(([word]) => word)).toEqual([]);
  });

  // A word with an offensive sense and an ordinary one is taught the ordinary one.
  // WordNet orders senses most common first, so the first clean sense is the best.
  test("a word with a valid meaning is taught that meaning", () => {
    const expected: Record<string, RegExp> = {
      queen: /female|monarch|ruler/i,
      tool: /implement/i,
      shrimp: /crustacean/i,
      pussy: /cat/i,
      cock: /faucet|rooster/i,
      taco: /tortilla/i,
      paddy: /rice/i,
      faggot: /bundle of sticks/i,
      chink: /narrow opening/i,
      dyke: /barrier/i,
      bunghole: /barrel|cask/i,
      pecker: /bird/i,
    };
    // Any of these may since have been excluded by hand, which is a decision this
    // test has no business overruling. It checks the ones still in the dictionary.
    const live = Object.entries(expected).filter(([word]) => dictionary.has(word));
    expect(live.length, "no example words left to check").toBeGreaterThan(3);
    for (const [word, pattern] of live) {
      const entry = vocab.defs[word];
      expect(entry, `${word} should have a definition`).toBeDefined();
      expect(definitionOf(entry), `${word} is taught the wrong sense`).toMatch(pattern);
    }
  });

  // A proper noun in the first sense used to disqualify the word outright, which
  // quietly cost ordinary words their definition.
  test("a name in the first sense does not cost the word its definition", () => {
    for (const word of ["begin", "west", "born", "hunt", "crane", "badger"]) {
      expect(vocab.defs[word], `${word} should have a definition`).toBeDefined();
    }
  });
});

/** Mirrors inflections() in tools/wordlist.py: the regular English forms of a word. */
function inflectionsOf(word: string): string[] {
  const out = [`${word}s`];
  if (/(?:s|x|z|ch|sh|o)$/.test(word)) out.push(`${word}es`);
  if (word.endsWith("y") && word.length > 2 && !"aeiou".includes(word[word.length - 2])) {
    out.push(`${word.slice(0, -1)}ies`);
  }
  if (word.endsWith("fe")) out.push(`${word.slice(0, -2)}ves`);
  else if (word.endsWith("f")) out.push(`${word.slice(0, -1)}ves`);
  return out;
}

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
