import { expect, it } from "vitest";
import { readSseData } from "./sse";

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
