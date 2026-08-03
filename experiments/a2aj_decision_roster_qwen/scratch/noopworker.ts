#!/usr/bin/env node

import { parentPort } from "node:worker_threads";

parentPort!.on("message", (batch: unknown) => {
  parentPort!.postMessage((batch as unknown[]).map(() => 1));
});
