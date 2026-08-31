import { useRef } from "react";
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
  /** A finger lifted after drawing across letters — the word is finished. */
  onDrawn?: () => void;
};

/** The cell under a point, or null if the point is not on a letter. */
function cellAtPoint(x: number, y: number): number | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>(".tile");
  if (!el) return null;
  const cell = Number(el.dataset.cell);
  return Number.isInteger(cell) ? cell : null;
}

/** Where a word can go next: adjacent to the last cell, and not already used. */
export function reachableFrom(selection: number[]): Set<number> | null {
  if (selection.length === 0) return null; // anywhere
  const used = new Set(selection);
  const last = selection[selection.length - 1];
  return new Set(ADJACENCY[last].filter((cell) => !used.has(cell)));
}

export function Board({
  cells,
  path,
  rejected,
  rotation = 0,
  selection = [],
  onTile,
  onDrawn,
}: Props) {
  // A drag is followed by asking what is under the finger, because every move
  // event during a touch is aimed at the element the touch started on.
  const drawing = useRef<{ from: number; last: number; moved: boolean } | null>(null);

  const beginDraw = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onTile) return;
    const cell = cellAtPoint(event.clientX, event.clientY);
    if (cell === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = { from: cell, last: cell, moved: false };
    onTile(cell);
  };

  const continueDraw = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = drawing.current;
    if (!drag || !onTile) return;
    const cell = cellAtPoint(event.clientX, event.clientY);
    if (cell === null || cell === drag.last) return;
    drag.last = cell;
    drag.moved = true;
    onTile(cell);
  };

  const endDraw = () => {
    const drag = drawing.current;
    drawing.current = null;
    // A tap leaves the word standing for another letter or the enter button; a
    // drawn word is finished the moment the finger comes up.
    if (drag?.moved) onDrawn?.();
  };
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
      onPointerDown={onTile ? beginDraw : undefined}
      onPointerMove={onTile ? continueDraw : undefined}
      onPointerUp={onTile ? endDraw : undefined}
      onPointerCancel={onTile ? endDraw : undefined}
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
            // detail is 0 only for a keyboard activation; a pointer has already
            // been dealt with above, and acting again would double the letter.
            onClick={(event) => !dead && event.detail === 0 && onTile(cell)}
          >
            {cells[cell]}
          </button>
        );
      })}
    </div>
  );
}
