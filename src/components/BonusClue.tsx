import type { BonusClue as Clue } from "../net/protocol";

type Props = {
  clue: Clue | null;
  /** The word, once you have found it. */
  found: string | null;
  /** The word, shown at the end whether or not you found it. */
  reveal?: string | null;
};

export function BonusClue({ clue, found, reveal }: Props) {
  if (!clue) return null;
  const word = found ?? reveal ?? null;
  return (
    <div className={`clue${found ? " clue--found" : ""}`}>
      <span className="clue__tag">
        {found ? "Bonus word" : word ? "Bonus word, missed" : `Bonus word · ${clue.length} letters`}
      </span>
      {word ? (
        <span className={found ? "clue__word" : "clue__word clue__word--missed"}>{word}</span>
      ) : (
        <span className="clue__pos">{clue.partOfSpeech}</span>
      )}
      <span className="clue__gloss">{clue.gloss}</span>
    </div>
  );
}
