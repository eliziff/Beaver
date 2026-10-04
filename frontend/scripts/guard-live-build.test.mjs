import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";
import { isFrontendLive } from "./guard-live-build.mjs";

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
    const previous = process.env.PORT;
    try {
        process.env.PORT = String(address.port);
        assert.equal(await isFrontendLive(), true);
    } finally {
        if (previous === undefined) delete process.env.PORT;
        else process.env.PORT = previous;
    }
});
