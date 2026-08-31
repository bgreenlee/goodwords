import { ADJACENCY, BOARD_SIZE, rotatedOrder, type Board as BoardCells } from "../game/dice";

type Props = {
  cells: BoardCells;
  /** Board cells to light up, e.g. the path of the word just accepted. */
  path?: number[];
  /** Cells of a word that was refused, shown briefly so the board answers too. */
  rejected?: number[];
  /** Quarter turns clockwise; the cells move but the letters stay upright. */
  rotation?: number;
  /** Cells tapped so far, in order. */
  selection?: number[];
  /** Tapping builds a word; omit to leave the board as a display. */
  onTile?: (cell: number) => void;
};

/** Where a word can go next: adjacent to the last cell, and not already used. */
export function reachableFrom(selection: number[]): Set<number> | null {
  if (selection.length === 0) return null; // anywhere
  const used = new Set(selection);
  const last = selection[selection.length - 1];
  return new Set(ADJACENCY[last].filter((cell) => !used.has(cell)));
}

export function Board({ cells, path, rejected, rotation = 0, selection = [], onTile }: Props) {
  const lit = new Set(path ?? []);
  const wrong = new Set(rejected ?? []);
  const order = rotatedOrder(rotation);
  const chosen = new Map(selection.map((cell, i) => [cell, i + 1]));
  const reachable = reachableFrom(selection);
  const last = selection[selection.length - 1];

  return (
    <div
      className="board"
      style={{ gridTemplateColumns: `repeat(${BOARD_SIZE}, 1fr)` }}
      aria-label="Letter board"
    >
      {order.map((cell, i) => {
        const at = chosen.get(cell);
        // While a word is being built, cells it cannot reach are stood down.
        const dead = onTile !== undefined && reachable !== null && !reachable.has(cell) && !at;
        const className = [
          "tile",
          wrong.has(cell) ? "tile--wrong" : "",
          lit.has(cell) && !at && !wrong.has(cell) ? "tile--lit" : "",
          at ? "tile--chosen" : "",
          cell === last ? "tile--last" : "",
          dead ? "tile--dead" : "",
        ]
          .filter(Boolean)
          .join(" ");

        if (!onTile) {
          return (
            <div key={i} className={className} data-cell={cell}>
              {cells[cell]}
            </div>
          );
        }
        return (
          <button
            key={i}
            type="button"
            className={className}
            data-cell={cell}
            // Stood-down cells stay in the tab order but do nothing, so the board
            // does not reshuffle under a keyboard user mid-word.
            aria-disabled={dead}
            aria-pressed={at !== undefined}
            aria-label={`${cells[cell]}${at ? `, letter ${at} of the word` : ""}`}
            onClick={() => !dead && onTile(cell)}
          >
            {cells[cell]}
          </button>
        );
      })}
    </div>
  );
}
