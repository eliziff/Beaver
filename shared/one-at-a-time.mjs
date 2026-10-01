/**
 * Runs the operations given to one gate strictly in turn. A caller that aborts while
 * it waits leaves the line at once without letting the next caller overtake the
 * operation still running.
 */
export function oneAtATime() {
  let tail = Promise.resolve();
  return async (run, signal) => {
    const previous = tail;
    let release;
    const finished = new Promise((resolve) => { release = resolve; });
    tail = previous.then(() => finished);
    try {
      await new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason);
        if (signal?.aborted) return abort();
        signal?.addEventListener("abort", abort, { once: true });
        void previous.then(() => { signal?.removeEventListener("abort", abort); resolve(); });
      });
      return await run();
    } finally { release(); }
  };
}
