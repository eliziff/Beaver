import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const entry = process.argv[2];
const w = new Worker(path.join(__dirname, 'wimport2.ts'), { execArgv: ['--import', pathToFileURL(entry).href] });
w.on('message', (m) => { console.log('WORKER SAYS', m); process.exit(0); });
w.on('error', (e) => { console.log('WORKER ERROR', e.message); process.exit(1); });
