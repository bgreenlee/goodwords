"""Look a word up the way the game sees it.

    ./checkword mosh queen midget

Says whether a word can be played, whether it is taught in the missed-words column
and whether it can name a round — and prints the line to paste into
wordlist/added.txt when there is a definition to be had.

Reads the built data in public/data, so it answers for the game as it currently
ships. WordNet is consulted only for a word the shipped data has no definition
for, and only if data/dict is present.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "data")
DICT = os.path.join(ROOT, "data", "dict")
# Said instead of "WordNet has none", which would not be true — it was never asked.
NO_WORDNET = "WordNet was not consulted (run tools/fetch-sources.sh for data/dict)"


def read_list(name):
    """Words on a hand-kept list, each with the comment block above it."""
    path = os.path.join(ROOT, "wordlist", name)
    if not os.path.exists(path):
        return {}
    out, comment = {}, []
    for line in open(path, encoding="utf-8"):
        stripped = line.strip()
        if stripped.startswith("#"):
            comment.append(stripped.lstrip("# ").rstrip())
            continue
        if not stripped:
            comment = []
            continue
        out[stripped.split("|")[0].strip().lower()] = " ".join(comment)
        comment = []
    return out


def wordnet_entry(word):
    """WordNet's definition for `word`, or None. Needs data/dict."""
    if not os.path.isdir(DICT):
        return None
    sys.path.insert(0, os.path.join(ROOT, "tools"))
    import wordnet as wn

    if not hasattr(wordnet_entry, "loaded"):
        wordnet_entry.loaded = wn.load(DICT)
    index, glosses, exc, forms = wordnet_entry.loaded
    return wn.teachable(word, index, glosses, exc, forms)


def report(word, data):
    words, freq, vocab, bonus, excluded, added = data
    print(f"\n{word}")

    if word in excluded:
        why = excluded[word] or "no reason recorded"
        print(f"  excluded by hand — {why}")
        print("  not playable, not taught, cannot name a round")
        return
    if word not in words:
        print("  not in the dictionary — cannot be played")
        entry = wordnet_entry(word)
        if entry:
            print("  WordNet has a definition, so this line would add and teach it:")
            print(f"    {word} | {entry[0]} | {entry[1].split(';')[0].strip()}")
            return
        if os.path.isdir(DICT):
            print("  WordNet has no entry either; add it with a definition of your own:")
        else:
            print(f"  {NO_WORDNET}; add it with a definition of your own:")
        print(f"    {word} | noun | ...")
        return

    lemma = vocab["lemmaOf"].get(word, word)
    entry = vocab["defs"].get(lemma)
    zipf = freq[words.index(word)] / 32
    bits = ["playable"]
    bits.append("taught" if entry else "not taught")
    bits.append("can name a round" if word in bonus else "cannot name a round")
    print(f"  {', '.join(bits)}  (zipf {zipf:.1f}" + (f", added by hand" if word in added else "") + ")")

    if entry:
        pos, gloss = entry.split("|", 1)
        if lemma != word:
            print(f"  taught through its root, {lemma}")
        print("  as it would appear in added.txt:")
        print(f"    {lemma} | {pos} | {gloss}")
        return

    print("  no definition, so it is never taught and cannot name a round")
    found = wordnet_entry(word)
    if found:
        print("  WordNet has one; this line would teach it:")
        print(f"    {word} | {found[0]} | {found[1].split(';')[0].strip()}")
    elif os.path.isdir(DICT):
        print("  WordNet has none either")
    else:
        print(f"  {NO_WORDNET}")


def main(argv):
    if not argv:
        sys.exit("usage: ./checkword <word> [word ...]")
    words = open(os.path.join(OUT, "words.txt"), encoding="utf-8").read().split("\n")
    data = (
        words,
        open(os.path.join(OUT, "freq.bin"), "rb").read(),
        json.load(open(os.path.join(OUT, "vocab.json"), encoding="utf-8")),
        {e[0] for e in json.load(open(os.path.join(OUT, "bonus.json"), encoding="utf-8"))},
        read_list("excluded.txt"),
        read_list("added.txt"),
    )
    for word in argv:
        report(word.strip().lower(), data)
    print()


if __name__ == "__main__":
    main(sys.argv[1:])
