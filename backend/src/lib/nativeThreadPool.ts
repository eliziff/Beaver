import { availableParallelism, totalmem } from "node:os";
import { isLocalRuntime } from "./localMode";

// Every long native call - DOCX and PDF derivation, OCR, passage geometry, the
// authority ledger's text units - is a libuv thread-pool task that holds its
// thread for the whole run, and all job lanes share one process. With libuv's
// default four threads a Write waiting on docxAuthorityTextUnits queues behind
// PDF preparation and logs nothing at all while it waits (measured: 9.3 s behind
// four occupied threads). Size the pool from the lanes that can occupy it.
export function jobLaneConcurrency() {
  const local = isLocalRuntime();
  return {
    chatTurns: local ? 2 : 4,
    preparation: local ? 1 : Math.min(4,
      Math.max(1, Math.floor(availableParallelism() / 8)),
      Math.max(1, Math.floor(totalmem() / (8 * 1024 ** 3)))),
    tabular: local ? 1 : 2,
  };
}

// libuv builds the pool when it first needs it and reads the size then, so this
// has to run before the process starts any asynchronous file, DNS or native work.
export function sizeNativeThreadPool() {
  if (process.env.UV_THREADPOOL_SIZE) return;
  const lanes = jobLaneConcurrency();
  // libuv's own four threads stay free for ordinary file and DNS work.
  process.env.UV_THREADPOOL_SIZE =
    String(lanes.chatTurns + lanes.preparation + lanes.tabular + 4);
}
