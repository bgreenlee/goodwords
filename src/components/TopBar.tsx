type Props = {
  name: string;
  learned: number;
  games: number;
  onHelp: () => void;
  onHistory: () => void;
};

export function TopBar({ name, learned, games, onHelp, onHistory }: Props) {
  return (
    <header className="topbar">
      <h1>
        Good Words <span className="topbar__tag">5×5 · 4 letters and up</span>
      </h1>
      <div className="topbar__right">
        {name && <span className="topbar__who">{name}</span>}
        <span className="topbar__stat">{learned} words seen</span>
        <button type="button" className="topbar__btn" onClick={onHistory}>
          Games{games > 0 ? ` · ${games}` : ""}
        </button>
        <button type="button" className="topbar__btn" onClick={onHelp} aria-label="How to play">
          How to play
        </button>
      </div>
    </header>
  );
}
