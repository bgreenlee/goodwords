import { BOARD_SIZE, rotatedOrder, type Board as BoardCells } from "../game/dice";

type Props = {
  cells: BoardCells;
  /** Board cells to light up, e.g. the path of the word just accepted. */
  path?: number[];
  /** Quarter turns clockwise; the cells move but the letters stay upright. */
  rotation?: number;
};

export function Board({ cells, path, rotation = 0 }: Props) {
  const lit = new Set(path ?? []);
  const order = rotatedOrder(rotation);
  return (
    <div
      className="board"
      style={{ gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)` }}
      aria-label="Letter board"
    >
      {order.map((cell, i) => (
        <div key={i} className={`tile${lit.has(cell) ? " tile--lit" : ""}`}>
          {cells[cell]}
        </div>
      ))}
    </div>
  );
}
