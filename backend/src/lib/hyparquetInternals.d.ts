// hyparquet's page-level decoders, which its package exports by path (hyparquet/src/*.js) with
// types this project's module resolution does not find.
declare module "hyparquet/src/thrift.js" {
  export function deserializeTCompactProtocol(reader: { view: DataView; offset: number }): Record<string, unknown>;
}
declare module "hyparquet/src/datapage.js" {
  export function decompressPage(bytes: Uint8Array, uncompressedSize: number, codec: string,
    compressors: undefined): Uint8Array;
}
declare module "hyparquet/src/encoding.js" {
  export function readRleBitPackedHybrid(reader: { view: DataView; offset: number }, width: number,
    output: number[], length?: number): void;
}
declare module "hyparquet/src/schema.js" {
  import type { SchemaElement } from "hyparquet";
  export type SchemaTree = { element: SchemaElement; children: SchemaTree[]; count: number; path: string[] };
  export function getSchemaPath(schema: SchemaElement[], name: string[]): SchemaTree[];
  export function getMaxDefinitionLevel(schemaPath: SchemaTree[]): number;
}
declare module "hyparquet/src/convert.js" {
  export const DEFAULT_PARSERS: Record<string, unknown>;
  export function convert(data: unknown[], decoder: unknown): unknown[];
}
