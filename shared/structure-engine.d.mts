export const SIGNATURES: Record<string, string[]>;
export function warmStructureAddon(addon: { citationEngineCall(method: string, request: string): unknown }): unknown;
export type StructureEngineTransport = {
  call(request: Uint8Array): Uint8Array;
  callAsync?(request: Uint8Array, progress?: (done: number, total: number) => void): Promise<Uint8Array>;
  restart?(): string;
  memoryBytes?(): number;
};
export function structureEngineAddon(transport: StructureEngineTransport, host?: {
  toBuffer?: (bytes: Uint8Array) => Uint8Array;
  recognizePdf?: (...args: unknown[]) => Promise<unknown>;
  parser?: unknown;
}): Record<string, unknown>;
