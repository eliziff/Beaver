import { parentPort } from 'node:worker_threads'; import { greet } from '../wlib3.ts'; parentPort.postMessage(greet);
