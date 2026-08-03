import { parentPort } from 'node:worker_threads'; import { greet } from './wlib.ts'; parentPort.postMessage(greet);
