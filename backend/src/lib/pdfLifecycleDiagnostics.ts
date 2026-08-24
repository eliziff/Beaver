import { channel } from "node:diagnostics_channel";

const lifecycle = channel("beaver.pdf.lifecycle");

export function pdfLifecycleMark(phase: string, documentId: string) {
  if (lifecycle.hasSubscribers) {
    const startedAt = performance.now();
    lifecycle.publish({ phase, documentId, startedAt, endedAt: startedAt, elapsedMs: 0 });
  }
}

export function pdfLifecyclePhase<T>(phase: string, documentId: string,
  operation: () => T): T {
  if (!lifecycle.hasSubscribers) return operation();
  const startedAt = performance.now();
  const publish = () => {
    const endedAt = performance.now();
    lifecycle.publish({ phase, documentId, startedAt, endedAt,
      elapsedMs: endedAt - startedAt });
  };
  try {
    const result = operation();
    if (result instanceof Promise) return result.finally(publish) as T;
    publish();
    return result;
  } catch (error) {
    publish();
    throw error;
  }
}
