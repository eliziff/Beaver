import { startJobWorker, type JobHandler } from "./jobQueue";

export type JobLane = { concurrency: number; handlers: Readonly<Record<string, JobHandler>> };

// A slow job cannot borrow another lane's reserved slots. Retain one durable
// queue, its atomic claims, retries and cancellation rather than a second queue.
export function startJobLanes(lanes: readonly JobLane[]) {
  const kinds = new Set<string>();
  for (const lane of lanes) {
    if (!Number.isInteger(lane.concurrency) || lane.concurrency < 1 || lane.concurrency > 8)
      throw new Error("Job lane concurrency must be an integer from 1 to 8");
    if (!Object.keys(lane.handlers).length) throw new Error("Job lane has no handlers");
    for (const kind of Object.keys(lane.handlers)) {
      if (kinds.has(kind)) throw new Error(`Job kind belongs to multiple lanes: ${kind}`);
      kinds.add(kind);
    }
  }
  const workers = lanes.flatMap(({ concurrency, handlers }) =>
    Array.from({ length: concurrency }, () => startJobWorker(handlers)));
  return { stop: () => Promise.all(workers.map((worker) => worker.stop())).then(() => undefined) };
}
