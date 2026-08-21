import { constants, getPriority, setPriority } from "node:os";

export function setBelowNormalProcessPriority() {
  const wanted = constants.priority.PRIORITY_BELOW_NORMAL;
  setPriority(0, wanted);
  const priority = getPriority(0);
  if (priority !== wanted) {
    throw new Error(`Process priority is ${priority}, expected BELOW_NORMAL (${wanted})`);
  }
  return { pid: process.pid, priority };
}
