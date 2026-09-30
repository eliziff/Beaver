export function createPdfRuntime<L extends { PDFWorker: new (...args: any[]) => any;
  GlobalWorkerOptions: { workerSrc: string } }>(lib: L, assets: {
  workerUrl: string; decoders?: Record<string, string>; fileOrigin?: boolean;
}): {
  options: { worker: InstanceType<L['PDFWorker']>;
    BinaryDataFactory: new (urls: Record<string, string>) => {
      fetch(input: { kind: string; filename: string }): Promise<Uint8Array>;
    }; useWorkerFetch: false; useWasm: true; isEvalSupported: false; enableHWA: true };
  destroy(): void;
};
export function openPdfDocument<L extends { getDocument: (...args: any[]) => any }>(
  lib: L, input: object, options: object): ReturnType<L['getDocument']>;
export function createPdfViewer<V extends new (...args: any[]) => any, E extends new (...args: any[]) => any>(
  lib: { PDFViewer: V; EventBus: E }, container: HTMLElement, element: HTMLElement, signal: AbortSignal
): { viewer: InstanceType<V>; eventBus: InstanceType<E>; destroy(): void };
