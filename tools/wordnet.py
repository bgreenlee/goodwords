"""Parse WordNet 3.1 dict files into a lemma -> definitions map, with Morphy
inflection handling so Boggle-list inflections resolve to their base lemma."""
import re, os

POS_FILES = {"n": "noun", "v": "verb", "a": "adj", "r": "adv"}
POS_LABEL = {"n": "noun", "v": "verb", "a": "adjective", "r": "adverb"}

# Morphy detachment rules: (suffix, replacement) per part of speech.
DETACH = {
    "n": [("s", ""), ("ses", "s"), ("xes", "x"), ("zes", "z"),
          ("ches", "ch"), ("shes", "sh"), ("men", "man"), ("ies", "y")],
    "v": [("s", ""), ("ies", "y"), ("es", "e"), ("es", ""),
          ("ed", "e"), ("ed", ""), ("ing", "e"), ("ing", "")],
    "a": [("er", ""), ("est", ""), ("er", "e"), ("est", "e")],
    "r": [],
}


def load(dict_dir):
    exc = {}
    for pos, name in POS_FILES.items():
        exc[pos] = {}
        path = os.path.join(dict_dir, f"{name}.exc")
        if not os.path.exists(path):
            continue
        for line in open(path, encoding="utf-8", errors="replace"):
            parts = line.split()
            if len(parts) >= 2:
                exc[pos][parts[0]] = parts[1:]

    # offset -> gloss, per pos. Also collect the surface forms each synset stores,
    # which preserve capitalization and so reveal proper nouns.
    glosses = {}
    forms = {}
    for pos, name in POS_FILES.items():
        g = {}
        for line in open(os.path.join(dict_dir, f"data.{name}"), encoding="utf-8", errors="replace"):
            if line.startswith("  "):
                continue
            head, _, gloss = line.partition("|")
            off = head[:8]
            g[off] = gloss.strip()
            f = head.split()
            # offset lex_filenum ss_type w_cnt (word lex_id)*
            w_cnt = int(f[3], 16)
            for k in range(w_cnt):
                forms.setdefault((pos, off), []).append(f[4 + 2 * k])
        glosses[pos] = g

    # lemma -> pos -> [offsets] (index order = sense order, most common first)
    index = {}
    for pos, name in POS_FILES.items():
        for line in open(os.path.join(dict_dir, f"index.{name}"), encoding="utf-8", errors="replace"):
            if line.startswith("  "):
                continue
            f = line.split()
            lemma = f[0]
            if "_" in lemma or "-" in lemma or "." in lemma or "'" in lemma:
                continue
            n_synsets = int(f[2])
            offsets = f[-n_synsets:]
            index.setdefault(lemma, {})[pos] = offsets
    return index, glosses, exc, forms


def base_forms(word, pos, index, exc):
    """Morphy: yield candidate base lemmas of `word` for part of speech `pos`."""
    out = []
    if word in index and pos in index[word]:
        out.append(word)
    for b in exc[pos].get(word, []):
        if b in index and pos in index[b]:
            out.append(b)
    for suf, rep in DETACH[pos]:
        if word.endswith(suf) and len(word) > len(suf):
            cand = word[: -len(suf)] + rep
            if cand in index and pos in index[cand]:
                out.append(cand)
    seen, uniq = set(), []
    for w in out:
        if w not in seen:
            seen.add(w)
            uniq.append(w)
    return uniq


def define(word, index, glosses, exc, max_senses=2):
    """Return [(pos_label, gloss)] for `word`, or [] if WordNet doesn't know it."""
    results = []
    for pos in ("n", "v", "a", "r"):
        for base in base_forms(word, pos, index, exc):
            for off in index[base][pos][:max_senses]:
                gl = glosses[pos].get(off)
                if gl:
                    results.append((POS_LABEL[pos], gl, base))
            break
    return results


# WordNet marks socially loaded senses in the gloss itself; we do not want the
# vocabulary column teaching slurs.
FLAGGED = re.compile(
    r"\((?:ethnic slur|slang|vulgar|obscene|offensive|disparaging|derogatory)",
    re.I,
)


def is_proper(word, pos, off, forms):
    """True when the synset stores this lemma capitalized, i.e. it is a proper noun."""
    for surface in forms.get((pos, off), []):
        if surface.lower() == word:
            return surface[0].isupper()
    return False


def teachable(word, index, glosses, exc, forms):
    """
    The definition to teach for `word`, or None.

    Only words that are their own WordNet lemma qualify: an inflection like "snores"
    or "wafted" teaches nothing its base form does not. Proper nouns and glosses
    WordNet flags as slurs or slang are excluded.
    """
    for pos in ("n", "v", "a", "r"):
        if pos not in index.get(word, {}):
            continue
        off = index[word][pos][0]
        gloss = glosses[pos].get(off)
        if not gloss or FLAGGED.search(gloss):
            return None
        if is_proper(word, pos, off, forms):
            return None
        return POS_LABEL[pos], gloss
    return None
