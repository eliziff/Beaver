export async function* readSseData(
    stream: ReadableStream<Uint8Array>,
    options: {
        signal?: AbortSignal;
        frameLimit?: number;
        bufferLimit?: number;
        responseLimit?: number;
        onLimit?: () => never;
    } = {},
): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let total = 0;
    const limit = options.onLimit ?? (() => { throw new RangeError("SSE limit exceeded"); });
    const abort = () => void reader.cancel().catch(() => undefined);
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
        while (!options.signal?.aborted) {
            const { done, value } = await reader.read();
            if (options.signal?.aborted) return;
            const text = decoder.decode(value, { stream: !done });
            total += text.length;
            if (total > (options.responseLimit ?? Infinity)) limit();
            buffer += text;
            if (buffer.length > (options.bufferLimit ?? Infinity)) limit();
            if (done) buffer += "\n\n";
            const records = buffer.split(/\r?\n\r?\n/u);
            buffer = records.pop() ?? "";
            for (const record of records) {
                const lines = record.split(/\r?\n/u).filter((line) => line === "data" || line.startsWith("data:"));
                if (!lines.length) continue;
                const data = lines.map((line) => line.slice(line[4] === ":" ? 5 : 4).replace(/^ /u, "")).join("\n");
                if (data.length > (options.frameLimit ?? Infinity)) limit();
                yield data;
                if (data === "[DONE]") return;
            }
            if (done) return;
        }
    } finally {
        options.signal?.removeEventListener("abort", abort);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
    }
}
