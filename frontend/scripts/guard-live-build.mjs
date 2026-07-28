import net from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const BUILD_BLOCKED_MESSAGE =
    "Frontend build blocked because Beaver is listening on 127.0.0.1:3000. Run `.\\scripts\\mike.ps1 stop`, build, then run `.\\scripts\\mike.ps1 start -WithTableOfAuthorities`.";

export function isFrontendLive({
    host = "127.0.0.1",
    port = 3000,
    timeoutMs = 200,
} = {}) {
    return new Promise((done) => {
        const socket = net.createConnection({ host, port });
        const finish = (live) => {
            socket.destroy();
            done(live);
        };
        socket.setTimeout(timeoutMs);
        socket.once("connect", () => finish(true));
        socket.once("error", () => finish(false));
        socket.once("timeout", () => finish(false));
    });
}

export async function assertBuildSafe(probe = isFrontendLive) {
    if (await probe()) throw new Error(BUILD_BLOCKED_MESSAGE);
}

const isMain =
    process.argv[1] &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
    try {
        await assertBuildSafe();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
