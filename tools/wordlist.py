"""Apply the hand-kept exclusions and additions to the built game data.

Runs on the files in public/data, which are committed — so excluding a word needs
no source corpora, no WordNet download and no Python packages. Edit the list,
run `npm run wordlist`, commit the result.

Idempotent: running it twice changes nothing the second time.
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LISTS = os.path.join(ROOT, "wordlist")
# A word added with a definition needs a frequency to be teachable at all; this
# puts it in the middle of the band the definitions column draws from.
ADDED_ZIPF = 3.0


def read_list(name, lists_dir=LISTS):
    """Lines of a list file, without comments or blanks."""
    path = os.path.join(lists_dir, name)
    if not os.path.exists(path):
        return []
    out = []
    for line in open(path, encoding="utf-8"):
        line = line.split("#")[0].strip()
        if line:
            out.append(line)
    return out


def apply(out_dir, lists_dir=LISTS):
    words = open(os.path.join(out_dir, "words.txt"), encoding="utf-8").read().split("\n")
    freq = bytearray(open(os.path.join(out_dir, "freq.bin"), "rb").read())
    vocab = json.load(open(os.path.join(out_dir, "vocab.json"), encoding="utf-8"))
    bonus = json.load(open(os.path.join(out_dir, "bonus.json"), encoding="utf-8"))
    defs, lemma_of = vocab["defs"], vocab["lemmaOf"]

    # Excluding a word excludes every form of it, in both directions: someone
    # pasting "midgets" from a report must get the headword dropped too, not just
    # the plural they happened to be shown.
    listed = {w.lower() for w in read_list("excluded.txt", lists_dir)}
    roots = {lemma_of.get(w, w) for w in listed}
    excluded = set(listed) | roots
    for word, lemma in lemma_of.items():
        if lemma in roots or word in listed:
            excluded.add(word)

    pairs = [(w, freq[i]) for i, w in enumerate(words) if w and w not in excluded]

    added, added_defs = [], {}
    for entry in read_list("added.txt", lists_dir):
        parts = [p.strip() for p in entry.split("|")]
        word = parts[0].lower()
        if not word.isalpha() or len(word) < 4 or word in excluded:
            continue
        added.append(word)
        if len(parts) >= 3 and parts[2]:
            added_defs[word] = f"{parts[1]}|{parts[2]}"

    have = {w for w, _ in pairs}
    for word in added:
        if word not in have:
            pairs.append((word, min(255, round(ADDED_ZIPF * 32))))
            have.add(word)

    pairs.sort()
    with open(os.path.join(out_dir, "words.txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(w for w, _ in pairs))
    with open(os.path.join(out_dir, "freq.bin"), "wb") as f:
        f.write(bytes(n for _, n in pairs))

    for word in excluded:
        defs.pop(word, None)
        lemma_of.pop(word, None)
    # An inflection whose headword has gone has nothing left to point at.
    for word, lemma in list(lemma_of.items()):
        if lemma not in defs:
            lemma_of.pop(word, None)
    defs.update(added_defs)
    with open(os.path.join(out_dir, "vocab.json"), "w", encoding="utf-8") as f:
        json.dump({"defs": defs, "lemmaOf": lemma_of}, f, separators=(",", ":"), sort_keys=True)

    kept = [entry for entry in bonus if entry[0] not in excluded]
    for word, entry in added_defs.items():
        if len(word) >= 6 and not any(b[0] == word for b in kept):
            kept.append([word, entry])
    # Longest first, then rarest: the room takes the first the board can spell.
    kept.sort(key=lambda entry: -len(entry[0]))
    with open(os.path.join(out_dir, "bonus.json"), "w", encoding="utf-8") as f:
        json.dump(kept, f, separators=(",", ":"))

    print(f"excluded {len(excluded)} words ({len(listed)} listed, rest are their forms)")
    print(f"added {len(added)} words, {len(added_defs)} of them with a definition")
    print(f"dictionary now {len(pairs)} words, {len(kept)} bonus candidates")


if __name__ == "__main__":
    apply(os.path.join(ROOT, "public", "data"))
    sys.exit(0)
