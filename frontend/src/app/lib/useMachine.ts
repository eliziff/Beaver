import { useCallback, useRef, useState } from "react";

/** A reducer whose state a handler or effect can also read at once (`latest.current`), before React has rendered it.
 *  `transition` is a module-level function; an event that changes nothing renders nothing. */
export function useMachine<State, Event>(transition: (state: State, event: Event) => State, initial: State | (() => State)) {
  const [state, setState] = useState(initial);
  const latest = useRef(state);
  const send = useCallback((event: Event) => {
    const next = transition(latest.current, event);
    if (next !== latest.current) setState(latest.current = next);
  }, [transition]);
  return [state, send, latest] as const;
}
/** The transition of a machine whose state is simply the last value sent. */
export const toValue = <Value,>(_current: Value, next: Value) => next;
