import { brotliCompress, constants, gzip } from "node:zlib";
import { promisify } from "node:util";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

/** Precompute public asset representations, never HTML/configuration or API data.
 * @returns {import("vite").Plugin}
 */
export function precompressedAssets() {
    return {
        name: "beaver-precompressed-assets",
        apply: "build",
        generateBundle: {
            order: "post",
            async handler(_options, bundle) {
                await Promise.all(Object.values(bundle).map(async (asset) => {
                    if (!/^assets\/.*\.(?:js|css|svg)$/u.test(asset.fileName)) return;
                    const bytes = Buffer.from(asset.type === "chunk" ? asset.code : asset.source);
                    if (bytes.length < 1024) return;
                    const variants = await Promise.all([
                        brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
                        gz(bytes, { level: 6 }),
                    ]);
                    for (const [index, extension] of ["br", "gz"].entries()) {
                        if (variants[index].length >= bytes.length) continue;
                        this.emitFile({ type: "asset", fileName: `${asset.fileName}.${extension}`,
                            source: variants[index] });
                    }
                }));
            },
        },
    };
}
