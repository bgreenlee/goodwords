import { BOARD_SIZE, type Board as BoardCells } from "../game/dice";

type Props = {
  cells: BoardCells;
  /** Cells to light up, e.g. the path of the word just accepted. */
  path?: number[];
};

export function Board({ cells, path }: Props) {
  const lit = new Set(path ?? []);
  return (
    <div
      className="board"
      style={{ gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)` }}
      aria-label="Letter board"
    >
      {cells.map((face, i) => (
        <div key={i} className={`tile${lit.has(i) ? " tile--lit" : ""}`}>
          {face}
        </div>
      ))}
    </div>
  );
}
