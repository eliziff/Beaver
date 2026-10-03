import { afterEach, expect, it, vi } from "vitest";
import { readSseData } from "./sse";
import { BeaverApiError, followedRequest, PROGRESS_STREAM } from "./api/client";

afterEach(() => vi.unstubAllGlobals());

it("keeps fragmented progress records separate from the binary result", async () => {
    const prefix = new TextEncoder().encode(
        JSON.stringify({ progress: "Reading caf\u00e9" }) + "\n" +
        JSON.stringify({ result: { status: 206, type: "application/octet-stream" } }) + "\n",
    );
    const payload = new Uint8Array([0, 255, 10, 195, 169, 0, 200]);
    const bytes = new Uint8Array(prefix.length + payload.length);
    bytes.set(prefix); bytes.set(payload, prefix.length);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
        for (let index = 0; index < bytes.length; index += 3) controller.enqueue(bytes.slice(index, index + 3));
        controller.close();
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body,
        { headers: { "Content-Type": PROGRESS_STREAM } })));
    const progress: string[] = [];
    const result = await followedRequest("/progress-check", { method: "POST" }, message => progress.push(message));
    expect(progress).toEqual(["Reading caf\u00e9"]);
    expect(result.status).toBe(206);
    expect(result.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(payload);
});

it("preserves a followed result's error status and structured details", async () => {
    const packets = JSON.stringify({ result: { status: 409, type: "application/json" } }) + "\n" +
        JSON.stringify({ detail: "The saved version changed.", code: "version_changed" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(packets,
        { headers: { "Content-Type": PROGRESS_STREAM } })));
    await expect(followedRequest("/progress-check", { method: "POST" }, () => undefined))
        .rejects.toMatchObject({ name: BeaverApiError.name, status: 409, code: "version_changed",
            details: { detail: "The saved version changed.", code: "version_changed" } });
});

it("rejects a progress stream that ends without a result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"progress":"Reading"}\n',
        { headers: { "Content-Type": PROGRESS_STREAM } })));
    await expect(followedRequest("/progress-check", { method: "POST" }, () => undefined)).rejects.toThrow();
});

it("frames split UTF-8, CRLF, multiline data, DONE, and an unterminated EOF", async () => {
    const bytes = new TextEncoder().encode(
        "data: café\r\n\r\ndata: first\ndata: second\n\ndata:\n\ndata: [DONE]\r\n\r\ndata: ignored\n\n",
    );
    const split = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(bytes.slice(0, split));
            controller.enqueue(bytes.slice(split));
            controller.close();
        },
    });
    const read = async (body: ReadableStream<Uint8Array>) => {
        const data: string[] = [];
        for await (const event of readSseData(body)) data.push(event);
        return data;
    };

    expect(await read(stream)).toEqual(["café", "first\nsecond", "", "[DONE]"]);
    expect(
        await read(
            new Response("data: final").body as ReadableStream<Uint8Array>,
        ),
    ).toEqual(["final"]);
});
