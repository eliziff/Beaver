const { lstatSync, readdirSync, rmSync } = require("node:fs");
const path = require("node:path");

const localData = path.resolve(__dirname, "../.tmp/playwright-local");
function cleanupLocalData() {
  for (const ancestor of [path.dirname(localData), path.resolve(__dirname, "..")]) {
    try {
      if (lstatSync(ancestor).isSymbolicLink()) throw new Error(`Refusing linked E2E data ancestor: ${ancestor}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  const pending = [localData];
  while (pending.length) {
    const filename = pending.pop();
    let item;
    try { item = lstatSync(filename); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (item.isSymbolicLink()) throw new Error(`Refusing linked E2E data: ${filename}`);
    if (item.isDirectory()) pending.push(...readdirSync(filename).map(name => path.join(filename, name)));
  }
  rmSync(localData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
if (process.argv[2] === "prepare") cleanupLocalData();

module.exports = function teardown() {
  // Playwright closes webServer processes after global teardown. Wait until exit
  // so Windows SQLite handles are closed before removing the owned data root.
  process.once("exit", cleanupLocalData);
}

module.exports.localData = localData;
module.exports.cleanupLocalData = cleanupLocalData;
