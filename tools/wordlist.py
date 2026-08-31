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
# Must match BONUS_MIN_LENGTH / BONUS_MAX_LENGTH in tools/build_data.py.
BONUS_MIN_LENGTH = 6
BONUS_MAX_LENGTH = 13


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


def inflections(word):
    """The regular English forms of `word`.

    Only forms the spelling rules actually produce, so excluding "spic" does not
    reach "spices" and excluding "spik" does not reach "spikes". Anything generated
    is kept only if the dictionary already had it, so a non-word costs nothing.
    """
    out = {word + "s"}
    if word.endswith(("s", "x", "z", "ch", "sh", "o")):
        out.add(word + "es")
    if word.endswith("y") and len(word) > 2 and word[-2] not in "aeiou":
        out.add(word[:-1] + "ies")
    if word.endswith("fe"):
        out.add(word[:-2] + "ves")
    elif word.endswith("f"):
        out.add(word[:-1] + "ves")
    return out


def _plural(word):
    """The -s form, which is the plural of a noun and the he/she form of a verb."""
    if word.endswith(("s", "x", "z", "ch", "sh")):
        return word + "es"
    if word.endswith("o") and not word.endswith(("oo", "io")):
        return word + "es"
    if word.endswith("y") and len(word) > 2 and word[-2] not in "aeiou":
        return word[:-1] + "ies"
    return word + "s"


def _doubles(word):
    """True when the final consonant doubles: a single vowel then a single consonant."""
    return (
        len(word) >= 3
        and word[-1] not in "aeiouwxy"
        and word[-2] in "aeiou"
        and word[-3] not in "aeiou"
    )


def _past(word):
    if word.endswith("e"):
        return word + "d"
    if word.endswith("y") and len(word) > 2 and word[-2] not in "aeiou":
        return word[:-1] + "ied"
    return word + word[-1] + "ed" if _doubles(word) else word + "ed"


def _gerund(word):
    if word.endswith("e") and not word.endswith(("ee", "ye", "oe")):
        return word[:-1] + "ing"
    return word + word[-1] + "ing" if _doubles(word) else word + "ing"


def added_forms(word, pos):
    """The regular forms of a word being added.

    Exclusion can generate loose candidates, because a form is dropped only if the
    dictionary already had it and a wrong guess costs nothing. Addition has no such
    safety net — a wrong form becomes a word people can play — so these are the
    forms the spelling rules actually produce, and only the ones the given part of
    speech has. An irregular word still needs its forms listed by hand.
    """
    forms = {_plural(word)}
    if pos.startswith("verb"):
        forms |= {_past(word), _gerund(word)}
    return forms


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
    # lemmaOf only covers words that have a definition, and a word whose every
    # sense is a slur has none — so the plurals of the very worst words were the
    # ones it could not reach. Generate the regular forms as well.
    for word in list(excluded):
        excluded |= inflections(word)

    pairs = [(w, freq[i]) for i, w in enumerate(words) if w and w not in excluded]

    added, added_defs, added_lemmas = [], {}, {}
    for entry in read_list("added.txt", lists_dir):
        parts = [p.strip() for p in entry.split("|")]
        word = parts[0].lower()
        if not word.isalpha() or len(word) < 4 or word in excluded:
            continue
        added.append(word)
        pos = parts[1].lower() if len(parts) >= 2 else ""
        # The forms come along, so a list stays one line per word.
        forms = [f for f in added_forms(word, pos) if f.isalpha()]
        added.extend(forms)
        if len(parts) >= 3 and parts[2]:
            added_defs[word] = f"{parts[1]}|{parts[2]}"
            # Point the forms at the word, the way the rest of the dictionary works:
            # missing "moshing" should teach "mosh", as missing "mooches" teaches
            # "mooch". Without this a form is playable but teaches nothing.
            for form in forms:
                added_lemmas[form] = word

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
    lemma_of.update(added_lemmas)
    with open(os.path.join(out_dir, "vocab.json"), "w", encoding="utf-8") as f:
        json.dump({"defs": defs, "lemmaOf": lemma_of}, f, separators=(",", ":"), sort_keys=True)

    # A round's clue is stored beside the word, so overriding a definition has to
    # reach it too or the clue and the vocabulary column would disagree. An
    # inflection carries its headword's gloss, so follow the lemma.
    kept = []
    for word, entry in bonus:
        if word in excluded:
            continue
        lemma = word if word in added_defs else lemma_of.get(word, word)
        kept.append([word, added_defs.get(lemma, entry)])
    # Same rule the build uses: long enough to be a hunt, short enough to fit, and
    # backed by a definition of its own or its root's.
    have_bonus = {word for word, _ in kept}
    for word in added:
        entry = added_defs.get(word) or added_defs.get(added_lemmas.get(word, ""))
        if entry and BONUS_MIN_LENGTH <= len(word) <= BONUS_MAX_LENGTH and word not in have_bonus:
            kept.append([word, entry])
            have_bonus.add(word)
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
