import { availableParallelism, totalmem } from "node:os";

// Every long native call - DOCX and PDF derivation, OCR, passage geometry, the
// authority ledger's text units - is a libuv thread-pool task that holds its
// thread for the whole run, and all job lanes share one process. With libuv's
// default four threads a Write waiting on docxAuthorityTextUnits queues behind
// PDF preparation and logs nothing at all while it waits (measured: 9.3 s behind
// four occupied threads). Size the pool from the lanes that can occupy it.
export function jobLaneConcurrency() {
  return {
    chatTurns: 4,
    preparation: Math.min(4,
      Math.max(1, Math.floor(availableParallelism() / 8)),
      Math.max(1, Math.floor(totalmem() / (8 * 1024 ** 3)))),
    tabular: 2,
  };
}

// libuv reads the size from the environment a process was spawned with (setting
// process.env inside the process reaches libuv on Linux only if nothing has used
// the pool yet, and never on Windows), so the supervisor sets it before it forks
// the services. Measured here: the pool stayed at four when a service set it.
export function sizeNativeThreadPool() {
  if (process.env.UV_THREADPOOL_SIZE) return;
  const lanes = jobLaneConcurrency();
  // libuv's own four threads stay free for ordinary file and DNS work.
  process.env.UV_THREADPOOL_SIZE =
    String(lanes.chatTurns + lanes.preparation + lanes.tabular + 4);
}
