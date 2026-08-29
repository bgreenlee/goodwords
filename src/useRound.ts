import { useEffect, useState } from "react";
import { roundAt, type RoundState } from "./game/schedule";

/** Tracks the globally scheduled round by polling the wall clock. */
export function useRound(): RoundState {
  const [state, setState] = useState(() => roundAt(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setState(roundAt(Date.now())), 200);
    return () => clearInterval(id);
  }, []);
  return state;
}
