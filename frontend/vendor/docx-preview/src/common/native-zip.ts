export type ZipOutputType = "string" | "blob" | "uint8array";

const EOCD = 0x06054b50;
const CENTRAL_FILE = 0x02014b50;
const LOCAL_FILE = 0x04034b50;
const decoder = new TextDecoder();

export class NativeZipEntry {
    constructor(
        private readonly archive: Uint8Array,
        private readonly offset: number,
        private readonly compressedSize: number,
        private readonly size: number,
        private readonly method: number,
    ) {}

    async async(type: ZipOutputType): Promise<string | Blob | Uint8Array> {
        const view = new DataView(
            this.archive.buffer,
            this.archive.byteOffset,
            this.archive.byteLength,
        );
        if (view.getUint32(this.offset, true) !== LOCAL_FILE) {
            throw new Error("Invalid ZIP local header");
        }
        const start =
            this.offset +
            30 +
            view.getUint16(this.offset + 26, true) +
            view.getUint16(this.offset + 28, true);
        const compressed = this.archive.subarray(
            start,
            start + this.compressedSize,
        );
        let bytes: Uint8Array;
        if (this.method === 0) {
            bytes = compressed;
        } else if (this.method === 8) {
            const stream = new Response(compressed).body!.pipeThrough(
                new DecompressionStream("deflate-raw"),
            );
            bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        } else {
            throw new Error(`Unsupported ZIP compression method ${this.method}`);
        }
        if (bytes.byteLength !== this.size) {
            throw new Error("Invalid ZIP entry size");
        }
        if (type === "string") return decoder.decode(bytes);
        if (type === "blob") return new Blob([bytes]);
        return bytes;
    }
}

export class NativeZip {
    readonly files: Record<string, NativeZipEntry> = {};

    static async load(input: Blob | ArrayBuffer | ArrayBufferView) {
        const archive =
            input instanceof Blob
                ? new Uint8Array(await input.arrayBuffer())
                : ArrayBuffer.isView(input)
                  ? new Uint8Array(
                        input.buffer,
                        input.byteOffset,
                        input.byteLength,
                    )
                  : new Uint8Array(input);
        const zip = new NativeZip();
        zip.readDirectory(archive);
        return zip;
    }

    private readDirectory(archive: Uint8Array) {
        const view = new DataView(
            archive.buffer,
            archive.byteOffset,
            archive.byteLength,
        );
        const floor = Math.max(0, archive.byteLength - 65_557);
        let end = archive.byteLength - 22;
        while (end >= floor && view.getUint32(end, true) !== EOCD) end--;
        if (end < floor) throw new Error("Invalid ZIP end record");
        const entries = view.getUint16(end + 10, true);
        let cursor = view.getUint32(end + 16, true);
        if (entries === 0xffff || cursor === 0xffffffff) {
            throw new Error("ZIP64 DOCX files are unsupported");
        }
        for (let index = 0; index < entries; index++) {
            if (view.getUint32(cursor, true) !== CENTRAL_FILE) {
                throw new Error("Invalid ZIP directory");
            }
            const flags = view.getUint16(cursor + 8, true);
            if (flags & 1) throw new Error("Encrypted DOCX files are unsupported");
            const nameLength = view.getUint16(cursor + 28, true);
            const extraLength = view.getUint16(cursor + 30, true);
            const commentLength = view.getUint16(cursor + 32, true);
            const name = decoder.decode(
                archive.subarray(cursor + 46, cursor + 46 + nameLength),
            );
            this.files[name] = new NativeZipEntry(
                archive,
                view.getUint32(cursor + 42, true),
                view.getUint32(cursor + 20, true),
                view.getUint32(cursor + 24, true),
                view.getUint16(cursor + 10, true),
            );
            cursor += 46 + nameLength + extraLength + commentLength;
        }
    }
}
