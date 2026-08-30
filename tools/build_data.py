"""Build the static game data.

Outputs into public/data/:
  words.txt   sorted ENABLE words of 4+ letters, one per line (the dictionary)
  freq.bin    one byte per word in words.txt order: round(zipf * 32), clamped
  vocab.json  { defs: lemma -> "pos|gloss", lemmaOf: inflection -> lemma }

Definitions exist only for lemmas, because an inflection like "snores" teaches
nothing its base form does not. `lemmaOf` lets a missed inflection point at the
lemma worth learning.
"""
import json, os, sys, gzip, subprocess

sys.path.insert(0, os.path.dirname(__file__))
import wordnet as wn
from wordfreq import zipf_frequency

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DICT = os.path.join(ROOT, "data", "dict")
OUT = os.path.join(ROOT, "public", "data")

# Below this zipf a word is a Scrabble-list artifact, not vocabulary worth teaching.
VOCAB_ZIPF_FLOOR = 1.6
GLOSS_MAX = 130
# A bonus word has to be a hunt, and has to be worth having hunted.
BONUS_MIN_LENGTH = 6
# Measured over 400 boards the longest findable word was 11 letters; 13 is headroom
# and everything past it is dead weight in the room's memory.
BONUS_MAX_LENGTH = 13
BONUS_ZIPF_MIN = 1.8
BONUS_ZIPF_MAX = 4.4


def clean_gloss(g):
    """WordNet appends quoted usage examples after the definition proper."""
    for sep in (';"', '; "'):
        g = g.split(sep)[0]
    g = g.strip().rstrip(";").strip()
    if len(g) > GLOSS_MAX:
        cut = g.rfind(" ", 0, GLOSS_MAX)
        g = g[: cut if cut > 0 else GLOSS_MAX].rstrip(",;: ") + "…"
    return g


def main():
    os.makedirs(OUT, exist_ok=True)
    words = sorted({w.strip().lower() for w in open(os.path.join(ROOT, "data", "enable1.txt"))
                    if len(w.strip()) >= 4 and w.strip().isalpha()})
    print(f"words (4+ letters): {len(words)}")
    with open(os.path.join(OUT, "words.txt"), "w") as f:
        f.write("\n".join(words))

    zipf = {w: zipf_frequency(w, "en") for w in words}
    with open(os.path.join(OUT, "freq.bin"), "wb") as f:
        f.write(bytes(min(255, max(0, round(zipf[w] * 32))) for w in words))

    index, glosses, exc, forms = wn.load(DICT)

    defs, lemma_of = {}, {}
    for w in words:
        # The lemma this board word should teach: itself, or the base it inflects from.
        candidates = [w] if w in index else []
        for pos in ("n", "v", "a", "r"):
            candidates.extend(wn.base_forms(w, pos, index, exc))
        for lemma in candidates:
            if lemma in defs:
                if lemma != w:
                    lemma_of[w] = lemma
                break
            # A lemma is only worth teaching if it is itself common enough to be real.
            if zipf.get(lemma, zipf_frequency(lemma, "en")) < VOCAB_ZIPF_FLOOR:
                continue
            t = wn.teachable(lemma, index, glosses, exc, forms)
            if not t:
                continue
            pos, gloss = t
            defs[lemma] = f"{pos}|{clean_gloss(gloss)}"
            if lemma != w:
                lemma_of[w] = lemma
            break

    with open(os.path.join(OUT, "vocab.json"), "w") as f:
        json.dump({"defs": defs, "lemmaOf": lemma_of}, f, separators=(",", ":"), sort_keys=True)

    # Candidates for a round's bonus word: long enough to be a hunt, real enough to
    # be worth knowing. Longest first, then rarest, so the room takes the first one
    # the board can spell and stops.
    candidates = []
    for w in words:
        if not (BONUS_MIN_LENGTH <= len(w) <= BONUS_MAX_LENGTH):
            continue
        lemma = lemma_of.get(w, w)
        entry = defs.get(lemma)
        if not entry:
            continue
        z = zipf.get(lemma, 0.0)
        if z < BONUS_ZIPF_MIN or z > BONUS_ZIPF_MAX:
            continue
        candidates.append((-len(w), z, w, entry))
    candidates.sort()
    with open(os.path.join(OUT, "bonus.json"), "w") as f:
        json.dump([[w, entry] for _, _, w, entry in candidates], f, separators=(",", ":"))
    print(f"bonus word candidates ({BONUS_MIN_LENGTH}+ letters): {len(candidates)}")

    print(f"teachable lemmas: {len(defs)}")
    print(f"inflections mapped to a lemma: {len(lemma_of)}")
    for name in ("words.txt", "freq.bin", "vocab.json"):
        p = os.path.join(OUT, name)
        raw = os.path.getsize(p)
        gz = len(gzip.compress(open(p, "rb").read(), 9))
        br = subprocess.run(["brotli", "-c", "-q", "11", p], capture_output=True)
        brn = len(br.stdout) if br.returncode == 0 else 0
        print(f"  {name:11s} raw {raw/1024:8.0f}K  gzip {gz/1024:7.0f}K  brotli {brn/1024:7.0f}K")


if __name__ == "__main__":
    main()
