import { existsSync } from "node:fs";
import { defaultNativeAddon, nativeAddonFile } from "mike/shared/nativeAddonFile.mjs";
import { structureEngineAddon, type StructureEngineTransport } from "mike/shared/structure-engine.mjs";
import path from "node:path";
import type { EngineOperations } from "mike/shared/engine-types/operations";
import type { FailureKind } from "mike/shared/engine-types/FailureKind";
import type { NativeDocument } from "mike/shared/engine-types/NativeDocument";
export type { NativeDocument };

/** The kind of failure that stopped a PDF's parse, on the error the engine throws for it, whose message is the one a
 *  reader is told. */
export const pdfFailureKind = (error: unknown) =>
  error instanceof Error && "kind" in error ? error.kind as FailureKind : undefined;

function structureAddonRoot() {
  return path.resolve(__dirname, "../../../native/legal-structure-node");
}

/** The engine's operations (generated from dispatch.rs's table), and what structure-engine.mjs adds of its host's. */
type StructureAddon = EngineOperations & {
  /** Whether a document belongs to the engine now running: a WebAssembly engine started afresh (recycle) has lost the
   *  documents it made. */
  documentLive?(document: NativeDocument): boolean;
  memoryBytes?(): number;
  recycle?(): void;
  /** Whether the host recognizes scanned pages itself, on its own pool of recognizers. */
  schedulesRecognition?: boolean;
  /** A synchronous operation run off this thread, for a call long enough to hold up the event loop. */
  offThread<M extends keyof EngineOperations>(method: M, ...args: Parameters<EngineOperations[M]>):
    Promise<Awaited<ReturnType<EngineOperations[M]>>>;
};

let addon: StructureAddon | undefined;

export function structureNative() {
  if (addon) return addon;
  const root = structureAddonRoot();
  const filename = process.env.LEGAL_STRUCTURE_NATIVE?.trim() ||
    defaultNativeAddon(root);
  if (!existsSync(filename)) {
    throw new Error(`Missing legal structure native module: ${filename}`);
  }
  const module = { exports: {} } as NodeModule;
  process.dlopen(module, nativeAddonFile(filename, root));
  // The native addon is one call; the page's runtime supplies its WebAssembly engine already wrapped.
  const loaded = module.exports as StructureAddon | StructureEngineTransport;
  addon = "callAsync" in loaded ? structureEngineAddon(loaded, {
    toBuffer: (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  }) as unknown as StructureAddon : loaded as StructureAddon;
  return addon;
}

/** Whether a document kept from an earlier call can still be read. */
export const nativeDocumentLive = (document: NativeDocument) => structureNative().documentLive?.(document) ?? true;
