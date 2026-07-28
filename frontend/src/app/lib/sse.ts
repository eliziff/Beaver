export async function* readSseData(
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        if (done) buffer += "\n\n";

        const records = buffer.split(/\r?\n\r?\n/);
        buffer = records.pop() ?? "";
        for (const record of records) {
            const dataLines = record
                .split(/\r?\n/)
                .filter((line) => line === "data" || line.startsWith("data:"));
            if (!dataLines.length) continue;
            const data = dataLines
                .map((line) => line.slice(line[4] === ":" ? 5 : 4).replace(/^ /, ""))
                .join("\n");
            yield data;
            if (data === "[DONE]") return;
        }

        if (done) return;
    }
}
