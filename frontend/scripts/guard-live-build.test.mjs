import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import {
    assertBuildSafe,
    BUILD_BLOCKED_MESSAGE,
    isFrontendLive,
} from "./guard-live-build.mjs";

test("allows a build when the frontend port is free", async () => {
    await assert.doesNotReject(assertBuildSafe(async () => false));
});

test("blocks a build with the recovery sequence when the frontend is live", async () => {
    await assert.rejects(
        assertBuildSafe(async () => true),
        new Error(BUILD_BLOCKED_MESSAGE),
    );
});

test("detects a listening socket", async (context) => {
    const server = net.createServer();
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    context.after(() => new Promise((done) => server.close(done)));

    const address = server.address();
    assert.equal(typeof address, "object");
    assert.equal(
        await isFrontendLive({ port: address.port, timeoutMs: 100 }),
        true,
    );
});
