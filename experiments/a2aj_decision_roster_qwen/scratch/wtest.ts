import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const w = new Worker(path.join(__dirname, 'wimport.ts'), { execArgv: ['--import', pathToFileURL('').href] });
w.on('message', (m) => { console.log('WORKER SAYS', m); process.exit(0); });
w.on('error', (e) => { console.log('WORKER ERROR', e.message); process.exit(1); });
