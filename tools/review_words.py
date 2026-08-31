"""List dictionary words that WordNet's own glosses mark as slurs, for review.

Prints candidates; it excludes nothing. Which words a game should refuse is an
editorial call, and the list is full of words whose offensive sense is one of
several — "queen", "tool", "fairy" — so it needs a human. Move the ones you agree
with into wordlist/excluded.txt.

This reads data/dict, so run tools/fetch-sources.sh first.

It is a supplement and not a safety net: it would not have caught "midget", whose
gloss is the neutral "a person who is markedly small". A word can be a slur with
nothing in the dictionary saying so.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DICT = os.path.join(ROOT, "data", "dict")
OUT = os.path.join(ROOT, "public", "data")

# Markers that label the word itself. Plain "offensive" is useless — it matches
# football and every gloss describing a deed as offensive.
MARKERS = re.compile(
    r"(ethnic slur|racial slur|\bslur\b|disparaging term|offensive term|derogatory term"
    r"|term of disparagement|vulgar slang|obscene term|used disparagingly"
    r"|used offensively|\(offensive\)|\(vulgar\)|\(ethnic\b)",
    re.I,
)


def main():
    if not os.path.isdir(DICT):
        sys.exit("data/dict is missing; run tools/fetch-sources.sh first")
    words = set(open(os.path.join(OUT, "words.txt"), encoding="utf-8").read().split("\n"))
    vocab = json.load(open(os.path.join(OUT, "vocab.json"), encoding="utf-8"))
    bonus = {entry[0] for entry in json.load(open(os.path.join(OUT, "bonus.json"), encoding="utf-8"))}

    flagged = {}
    for name in ("data.noun", "data.verb", "data.adj", "data.adv"):
        for line in open(os.path.join(DICT, name), encoding="latin-1"):
            if line.startswith("  "):
                continue
            head, _, gloss = line.partition("| ")
            if not MARKERS.search(gloss):
                continue
            fields = head.split()
            for i in range(int(fields[3], 16)):
                word = re.sub(r"\(.*?\)", "", fields[4 + i * 2]).lower()
                if word in words:
                    flagged.setdefault(word, gloss.strip())

    # The sharpest cases first: the game does not merely accept these, it offers
    # them — teaching the definition, or naming one as the word to hunt for.
    def rank(word):
        return (0 if word in bonus else 1, 0 if word in vocab["defs"] else 1, word)

    print(f"{len(flagged)} dictionary words carry an offensive marker in WordNet.\n")
    for word in sorted(flagged, key=rank):
        tags = []
        if word in vocab["defs"]:
            tags.append("taught")
        if word in bonus:
            tags.append("can name a round")
        label = f"[{', '.join(tags)}]" if tags else "[playable only]"
        print(f"{word:14s} {label:26s} {flagged[word][:64]}")
    print("\nNothing was excluded. Move the ones you agree with into wordlist/excluded.txt.")


if __name__ == "__main__":
    main()
