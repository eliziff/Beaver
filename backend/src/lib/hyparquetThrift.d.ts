// hyparquet's Thrift decoder, which its package exports by path with types this project's module
// resolution does not find. a2ajInstall.ts reads Parquet page headers with it.
declare module "hyparquet/src/thrift.js" {
  export function deserializeTCompactProtocol(reader: { view: DataView; offset: number }): Record<string, unknown>;
}
