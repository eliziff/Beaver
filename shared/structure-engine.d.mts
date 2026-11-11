export type StructureEngineTransport = {
  prepare?(): Promise<void>;
  call(request: Uint8Array): Uint8Array;
  callAsync?(request: Uint8Array, progress?: (done: number, total: number) => void): Promise<Uint8Array>;
  restart?(): string;
  memoryBytes?(): number;
};
export function abandonable<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T>;
export function structureEngineAddon(transport: StructureEngineTransport, host?: {
  toBuffer?: (bytes: Uint8Array) => Uint8Array;
  recognizePdf?: (...args: unknown[]) => Promise<unknown>;
  parser?: unknown;
}): Record<string, unknown>;
