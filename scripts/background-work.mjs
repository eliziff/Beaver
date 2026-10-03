import { constants, setPriority } from 'node:os';

// Builds/tests yield to interactive work; inherited by their Node workers.
setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);
process.env.RAYON_NUM_THREADS ??= '1';
process.env.OMP_NUM_THREADS ??= '1';
const preload = `--import=${import.meta.url}`;
if (!process.env.NODE_OPTIONS?.includes(preload)) {
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} ${preload}`.trim();
}
