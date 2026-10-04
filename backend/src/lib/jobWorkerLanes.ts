import { startJobWorker, type JobHandler } from "./jobQueue";

export type JobLane = { concurrency: number; handlers: Readonly<Record<string, JobHandler>> };

// A slow job cannot borrow another lane's reserved slots. Retain one durable
// queue, its atomic claims, retries and cancellation rather than a second queue.
export function startJobLanes(lanes: readonly JobLane[]) {
  const workers = lanes.flatMap(({ concurrency, handlers }) =>
    Array.from({ length: concurrency }, () => startJobWorker(handlers)));
  return { stop: () => Promise.all(workers.map((worker) => worker.stop())).then(() => undefined) };
}
