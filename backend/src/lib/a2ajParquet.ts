// Exact citation and name lookups over A2AJ's Parquet corpus (a2ajCorpus.ts), from a folder or by
// HTTP range reads of Hugging Face, without scanning the corpus for each lookup.
//
// Each Parquet file gets a small index, built once and kept by the file's SHA-256: the lookup key of
// every citation and name to its rows, and where each large column's pages start. A2AJ's files have
// one row group and no page index, and a judgment's text sits in pages of tens of megabytes, so the
// page list is what lets a lookup read one page of one column instead of the whole column.
// Records come back in the shape A2AJ's API returns them (citation_en, unofficial_text_en, …).
/// <reference path="./hyparquetInternals.d.ts" />
import { parquetMetadataAsync, parquetReadObjects, type AsyncBuffer, type ColumnMetaData,
  type FileMetaData } from "hyparquet";
import { convert, DEFAULT_PARSERS } from "hyparquet/src/convert.js";
import { decompressPage } from "hyparquet/src/datapage.js";
import { readRleBitPackedHybrid } from "hyparquet/src/encoding.js";
import { getMaxDefinitionLevel, getSchemaPath } from "hyparquet/src/schema.js";
import { deserializeTCompactProtocol } from "hyparquet/src/thrift.js";
import { courtOf, installedA2AJFiles, type A2AJCorpusFile, type A2AJCorpusFolder, type A2AJKind,
  A2AJ_REPOSITORIES, fetchA2AJSnapshot } from "./a2ajCorpus";

const INDEX_VERSION = 1;
const CITATION_COLUMNS = ["citation_en", "citation2_en", "citation_fr", "citation2_fr"];
const NAME_COLUMNS = ["name_en", "name_fr"];
// A column this small is read whole: walking its pages would cost more requests than it saves.
const PAGED_COLUMN_BYTES = 1024 * 1024;
// Decompressed pages kept for the next lookup: a text page of a large court is 20 to 40 MB.
const PAGE_CACHE_BYTES = 160 * 1024 * 1024;

/** One Parquet file's lookup index. Rows are the file's row numbers. */
export type A2AJParquetIndex = {
  version: number; kind: A2AJKind; path: string; sha256: string; size: number; rows: number;
  citations: Record<string, number[]>;
  names: Record<string, number[]>;
  /** Large columns' data pages: [byte offset, bytes with header, first row]. */
  pages: Record<string, Array<[number, number, number]>>;
};

export type A2AJCorpusSource = {
  /** The corpus files available to read, by kind. */
  files(kind: A2AJKind): Promise<A2AJCorpusFile[]>;
  open(kind: A2AJKind, file: A2AJCorpusFile): AsyncBuffer;
  /** Where built indexes are kept, by file SHA-256. */
  indexes: { get(sha256: string): Promise<A2AJParquetIndex | null>; put(index: A2AJParquetIndex): Promise<void> };
};

/** Reads ALR-Quote-Verifier local_a2aj.py _name_lookup_key: a style of cause compared as its words. */
export function a2ajNameKey(value: string) {
  return value.replace(/(\w)\.(\w)\.?/gu, "$1$2").replace(/\s+v\.?\s+/giu, " v ")
    .replace(/[-‐-―/]+/gu, " ").replace(/[^\p{L}\p{N}_\s]/gu, "")
    .split(/\s+/u).filter(Boolean).join(" ").toLowerCase();
}

/** A page header as Thrift reads it: type, uncompressed and compressed sizes, the data page header
 *  (values, encoding) and the version 2 data page header (rows). */
type RawPageHeader = { field_1: number; field_2: number; field_3: number; field_5?: { field_1: number; field_2: number };
  field_8?: { field_3: number } };
/** Where each data page of a column chunk starts, read from the page headers. */
async function columnPages(file: AsyncBuffer, start: number, end: number) {
  const pages: Array<[number, number, number]> = [];
  let offset = start, row = 0;
  while (offset < end) {
    let header: RawPageHeader | undefined, length = 0;
    // A header carries the page's statistics, so its length is not known before reading it.
    for (let span = 16 * 1024; !header; span *= 8) {
      const view = new DataView(await file.slice(offset, Math.min(offset + span, end)));
      const reader = { view, offset: 0 };
      try { header = deserializeTCompactProtocol(reader) as unknown as RawPageHeader; length = reader.offset; }
      catch (error) { if (offset + span >= end) throw error; }
    }
    const size = length + header.field_3;
    // Type 2 is the dictionary page, which the reader finds from the column's own metadata.
    if (header.field_1 !== 2) {
      pages.push([offset, size, row]);
      row += header.field_5?.field_1 ?? header.field_8?.field_3 ?? 0;
    }
    offset += size;
  }
  return pages;
}

const columnNames = (metadata: FileMetaData) => new Set(metadata.row_groups[0]?.columns
  .map((chunk) => chunk.meta_data?.path_in_schema ?? []).filter((path) => path.length === 1).map((path) => path[0]));

/** Builds a Parquet file's lookup index. `citationKeys` is Beaver's citation lookup key, one per text. */
export async function indexA2AJParquet(kind: A2AJKind, corpusFile: A2AJCorpusFile, file: AsyncBuffer,
  citationKeys: (texts: string[]) => string[]): Promise<A2AJParquetIndex> {
  const metadata = await parquetMetadataAsync(file);
  if (metadata.row_groups.length !== 1) throw new Error(`${corpusFile.path} has ${metadata.row_groups.length} row groups; A2AJ's files have one.`);
  const present = columnNames(metadata);
  const columns = [...CITATION_COLUMNS, ...NAME_COLUMNS].filter((column) => present.has(column));
  const rows = await parquetReadObjects({ file, metadata, columns }) as Array<Record<string, unknown>>;
  const texts: string[] = [], owners: number[] = [];
  const names: Record<string, number[]> = {};
  const add = (map: Record<string, number[]>, key: string, row: number) => {
    const list = map[key] ??= [];
    if (list.at(-1) !== row) list.push(row);
  };
  rows.forEach((record, row) => {
    for (const column of CITATION_COLUMNS) {
      const value = record[column];
      if (typeof value === "string" && value.trim()) { texts.push(value); owners.push(row); }
    }
    for (const column of NAME_COLUMNS) {
      const value = record[column], key = typeof value === "string" ? a2ajNameKey(value) : "";
      if (key) add(names, key, row);
    }
  });
  const citations: Record<string, number[]> = {};
  citationKeys(texts).forEach((key, index) => { if (key) add(citations, key, owners[index]); });
  // Each column's pages are walked one header after another; the columns are walked at once.
  const pages: A2AJParquetIndex["pages"] = Object.fromEntries(await Promise.all(metadata.row_groups[0].columns
    .flatMap(({ meta_data: meta }) => !meta || meta.path_in_schema.length !== 1 ||
      Number(meta.total_compressed_size) < PAGED_COLUMN_BYTES ? [] : [meta])
    .map(async (meta) => {
      const start = Number(meta.dictionary_page_offset || meta.data_page_offset);
      return [meta.path_in_schema[0], await columnPages(file, start, start + Number(meta.total_compressed_size))] as const;
    })));
  return { version: INDEX_VERSION, kind, path: corpusFile.path, sha256: corpusFile.sha256, size: corpusFile.size,
    rows: Number(metadata.num_rows), citations, names, pages };
}

type Loaded = { file: A2AJCorpusFile; index: A2AJParquetIndex };
type Found = { kind: A2AJKind; file: A2AJCorpusFile; index: A2AJParquetIndex; row: number };
// A time reads as A2AJ's API gives it: 2016-07-08T00:00:00.
const plain = (value: unknown): unknown => value instanceof Date ? value.toISOString().slice(0, 19)
  : typeof value === "bigint" ? Number(value) : value;

/** A2AJ's Parquet corpus, read through a source: lookups by citation or name, and whole records. */
export class A2AJParquetCorpus {
  private readonly loading = new Map<A2AJKind, Promise<Loaded[]>>();
  private readonly metadata = new Map<string, Promise<FileMetaData>>();
  private readonly cache = new Map<string, { value: Promise<{ byteLength: number }>; bytes: number }>();
  private cached = 0;
  private readonly lookups = new Map<A2AJKind, Promise<{ citations: Map<string, Found[]>; names: Map<string, Found[]> }>>();

  constructor(private readonly source: A2AJCorpusSource,
    private readonly citationKeys: (texts: string[]) => string[]) {}

  /** Every file's index, built the first time it is asked for and kept by the source. */
  private indexes(kind: A2AJKind) {
    let loading = this.loading.get(kind);
    if (!loading) {
      loading = this.source.files(kind).then((files) => Promise.all(files.map(async (file) => {
        const kept = await this.source.indexes.get(file.sha256).catch(() => null);
        if (kept?.version === INDEX_VERSION && kept.sha256 === file.sha256) return { file, index: kept };
        const index = await indexA2AJParquet(kind, file, this.source.open(kind, file), this.citationKeys);
        await this.source.indexes.put(index).catch(() => undefined);
        return { file, index };
      })));
      loading.catch(() => this.loading.delete(kind));
      this.loading.set(kind, loading);
    }
    return loading;
  }

  private lookup(kind: A2AJKind) {
    let lookup = this.lookups.get(kind);
    if (!lookup) {
      lookup = this.indexes(kind).then((loaded) => {
        const citations = new Map<string, Found[]>(), names = new Map<string, Found[]>();
        for (const { file, index } of loaded) {
          for (const [map, keys] of [[citations, index.citations], [names, index.names]] as const)
            for (const [key, rows] of Object.entries(keys)) {
              const found = map.get(key) ?? [];
              for (const row of rows) found.push({ kind, file, index, row });
              map.set(key, found);
            }
        }
        return { citations, names };
      });
      lookup.catch(() => this.lookups.delete(kind));
      this.lookups.set(kind, lookup);
    }
    return lookup;
  }

  /** The courts this corpus holds, by kind, and how many documents each index lists. */
  async coverage(kind: A2AJKind) {
    return (await this.indexes(kind)).map(({ file, index }) => ({ court: courtOf(file.path), documents: index.rows }));
  }

  /** Records whose citation (or alternate citation, in either language) has this lookup key. */
  async byCitation(kind: A2AJKind, citation: string, options: { dataset?: string; language?: "en" | "fr" } = {}) {
    const key = this.citationKeys([citation])[0];
    if (!key) return [];
    return this.read((await this.lookup(kind)).citations.get(key) ?? [], options.dataset, options.language);
  }

  /** Records whose style of cause or title reads as this name. */
  async byName(kind: A2AJKind, name: string, options: { dataset?: string; language?: "en" | "fr" } = {}) {
    const key = a2ajNameKey(name);
    if (!key) return [];
    return this.read((await this.lookup(kind)).names.get(key) ?? [], options.dataset, options.language);
  }

  private fileMetadata(found: Found, file: AsyncBuffer) {
    let metadata = this.metadata.get(found.file.sha256);
    if (!metadata) {
      metadata = parquetMetadataAsync(file);
      metadata.catch(() => this.metadata.delete(found.file.sha256));
      this.metadata.set(found.file.sha256, metadata);
    }
    return metadata;
  }

  /** Bytes of a file, decompressed when they are a page, kept a while: footnotes cite a court's
   *  judgments together, and one page holds about a thousand of them. */
  private kept<T extends { byteLength: number }>(key: string, produce: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit.value as Promise<T>; }
    const value = produce();
    const entry = { value, bytes: 0 };
    this.cache.set(key, entry);
    value.then((result) => {
      entry.bytes = result.byteLength; this.cached += result.byteLength;
      for (const [other, kept] of this.cache) {
        if (this.cached <= PAGE_CACHE_BYTES || other === key) break;
        this.cache.delete(other); this.cached -= kept.bytes;
      }
    }, () => this.cache.delete(key));
    return value;
  }

  /** A page's header and decompressed bytes. */
  private page(entry: Found, file: AsyncBuffer, chunk: ColumnMetaData, offset: number, size: number) {
    return this.kept(`${entry.file.sha256}:${offset}`, async () => {
      const view = new DataView(await file.slice(offset, offset + size));
      const reader = { view, offset: 0 };
      const header = deserializeTCompactProtocol(reader) as unknown as RawPageHeader;
      const bytes = decompressPage(new Uint8Array(view.buffer, view.byteOffset + reader.offset, header.field_3),
        header.field_2, chunk.codec, undefined);
      return Object.assign(bytes, { header });
    });
  }

  /** One row's value of one flat column, decoding only that value; undefined when the page is
   *  laid out in a way this does not decode, for the ordinary reader to read instead. */
  private async cell(entry: Found, file: AsyncBuffer, metadata: FileMetaData, column: string) {
    const chunk = metadata.row_groups[0].columns.find(({ meta_data }) => meta_data?.path_in_schema.length === 1 &&
      meta_data.path_in_schema[0] === column)?.meta_data;
    if (!chunk) return undefined;
    const start = Number(chunk.dictionary_page_offset || chunk.data_page_offset);
    const end = start + Number(chunk.total_compressed_size);
    // A small column is read whole and its pages found in memory.
    const source: AsyncBuffer = entry.index.pages[column] ? file : { byteLength: file.byteLength,
      slice: async (from, to) => (await this.kept(`${entry.file.sha256}:chunk:${start}`, async () => file.slice(start, end)))
        .slice(from - start, (to ?? end) - start) };
    const pages = entry.index.pages[column] ?? await this.kept(`${entry.file.sha256}:pages:${start}`,
      async () => Object.assign(await columnPages(source, start, end), { byteLength: 64 }));
    let at = pages.length - 1;
    while (at >= 0 && pages[at][2] > entry.row) at--;
    if (at < 0) return undefined;
    const [offset, size, first] = pages[at];
    const data = await this.page(entry, source, chunk, offset, size);
    const header = data.header.field_5;
    // Version 2 data pages, and encodings other than plain and dictionary, are left to the ordinary reader.
    if (!header || ![0, 2, 8].includes(header.field_2)) return undefined;
    const schemaPath = getSchemaPath(metadata.schema, [column]);
    const element = schemaPath[schemaPath.length - 1].element;
    const reader = { view: new DataView(data.buffer, data.byteOffset, data.byteLength), offset: 0 };
    const maxDefinition = getMaxDefinitionLevel(schemaPath);
    let value = entry.row - first;
    if (maxDefinition) {
      const levels = new Array<number>(header.field_1);
      readRleBitPackedHybrid(reader, 32 - Math.clz32(maxDefinition), levels);
      if (levels[value] !== maxDefinition) return null;
      value = levels.slice(0, value).filter((level) => level === maxDefinition).length;
    }
    let values = reader;
    if (header.field_2 !== 0) {
      const width = reader.view.getUint8(reader.offset++);
      const indices = new Array<number>(value + 1);
      readRleBitPackedHybrid(reader, width, indices, reader.view.byteLength - reader.offset);
      // The dictionary page is the chunk's first page, before its first data page.
      const dictionary = await this.page(entry, source, chunk, start, pages[0][0] - start);
      values = { view: new DataView(dictionary.buffer, dictionary.byteOffset, dictionary.byteLength), offset: 0 };
      value = indices[value];
    }
    let raw: unknown;
    if (element.type === "BYTE_ARRAY") {
      for (let index = 0; index < value; index++) values.offset += 4 + values.view.getUint32(values.offset, true);
      const length = values.view.getUint32(values.offset, true);
      raw = new Uint8Array(values.view.buffer, values.view.byteOffset + values.offset + 4, length);
    } else if (element.type === "INT64") raw = values.view.getBigInt64(values.offset + 8 * value, true);
    else if (element.type === "INT32") raw = values.view.getInt32(values.offset + 4 * value, true);
    else return undefined;
    return convert([raw], { element, schemaPath, parsers: DEFAULT_PARSERS })[0];
  }

  private async read(found: Found[], dataset?: string, language: "en" | "fr" = "en") {
    const wanted = dataset?.trim().toLowerCase();
    const selected = found.filter(({ file }) => !wanted || courtOf(file.path).toLowerCase() === wanted).slice(0, 8);
    return Promise.all(selected.map(async (entry) => {
      const file = this.source.open(entry.kind, entry.file), metadata = await this.fileMetadata(entry, file);
      const present = columnNames(metadata), other = language === "en" ? "fr" : "en";
      const result: Record<string, unknown> = { dataset: courtOf(entry.file.path) };
      const readColumns = async (names: string[]) => {
        const values = await Promise.all(names.map((column) => this.cell(entry, file, metadata, column)));
        const missed = names.filter((_, index) => values[index] === undefined);
        if (missed.length) {
          const pageLocations = Object.fromEntries(Object.entries(entry.index.pages).map(([column, pages]) => [column,
            pages.map(([offset, size, row]) => ({ offset: BigInt(offset), compressed_page_size: size, first_row_index: BigInt(row) }))]));
          const [record] = await parquetReadObjects({ file, metadata, rowStart: entry.row, rowEnd: entry.row + 1,
            columns: missed, pageLocationsByGroup: [pageLocations] } as Parameters<typeof parquetReadObjects>[0]);
          missed.forEach((column) => { values[names.indexOf(column)] = record?.[column]; });
        }
        names.forEach((column, index) => {
          if (values[index] !== null && values[index] !== undefined) result[column] = plain(values[index]);
        });
      };
      // Text is read in the language asked for, and in the other only when the first has none.
      await readColumns([...present].filter((column) => !/^unofficial_(?:text|sections)_/u.test(column) ||
        column.endsWith(`_${language}`)));
      if (!result[`unofficial_text_${language}`])
        await readColumns([`unofficial_text_${other}`, `unofficial_sections_${other}`].filter((column) => present.has(column)));
      return result;
    }));
  }
}

/** A2AJ's corpus in a folder (a2ajCorpus.ts): the installed files, their indexes kept beside them. */
export function folderA2AJSource(folder: A2AJCorpusFolder): A2AJCorpusSource {
  return {
    files: (kind) => installedA2AJFiles(folder, kind),
    open: (kind, file) => ({ byteLength: file.size, slice: async (start, end) => {
      const bytes = await folder.read(`${kind}/${file.path}`, start, end ?? file.size);
      return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer as ArrayBuffer : bytes.slice().buffer as ArrayBuffer;
    } }),
    // Kept gzipped: the whole corpus's indexes are 20 MB as JSON and 4.3 MB compressed.
    indexes: {
      async get(sha256) {
        const path = `index/${sha256}.json.gz`, size = await folder.size(path);
        if (!size) return null;
        const stream = new Blob([await folder.read(path, 0, size)]).stream().pipeThrough(new DecompressionStream("gzip"));
        return JSON.parse(await new Response(stream).text()) as A2AJParquetIndex;
      },
      async put(index) {
        const path = `index/${index.sha256}.json.gz`, part = `${path}.part`;
        const stream = new Blob([JSON.stringify(index)]).stream().pipeThrough(new CompressionStream("gzip"));
        const writer = await folder.append(part, 0);
        await writer.write(new Uint8Array(await new Response(stream).arrayBuffer()));
        await writer.close();
        await folder.rename(part, path);
      },
    },
  };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
/**
 * A2AJ's corpus read from Hugging Face by HTTP range requests at its current revision, nothing
 * downloaded ahead. Each lookup reads the pages it needs, which for a judgment is tens of megabytes.
 */
export function huggingFaceA2AJSource(options: { fetch: Fetch; indexes: A2AJCorpusSource["indexes"] }): A2AJCorpusSource {
  const snapshots = new Map<A2AJKind, ReturnType<typeof fetchA2AJSnapshot>>();
  const snapshot = (kind: A2AJKind) => {
    let pending = snapshots.get(kind);
    if (!pending) {
      pending = fetchA2AJSnapshot(kind, options.fetch);
      pending.catch(() => snapshots.delete(kind));
      snapshots.set(kind, pending);
    }
    return pending;
  };
  const revisions = new Map<string, string>();
  return {
    async files(kind) {
      const { revision, files } = await snapshot(kind);
      for (const file of files) revisions.set(file.sha256, revision);
      return files;
    },
    open: (kind, file) => ({ byteLength: file.size, async slice(start, end) {
      const url = `https://huggingface.co/datasets/${A2AJ_REPOSITORIES[kind]}/resolve/${
        encodeURIComponent(revisions.get(file.sha256) ?? "main")}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
      const last = (end ?? file.size) - 1;
      const response = await options.fetch(url, { credentials: "omit", referrerPolicy: "no-referrer",
        headers: { Range: `bytes=${start}-${last}` } });
      if (response.status !== 206 && !(response.ok && start === 0 && last === file.size - 1))
        throw new Error(`Hugging Face did not send part of ${file.path} (${response.status}).`);
      return response.arrayBuffer();
    } }),
    indexes: options.indexes,
  };
}

/** Where a page keeps the indexes of corpus files it reads from Hugging Face: IndexedDB when the
 *  page or Worker has it, else memory for this visit. */
type StoreRequest<T> = { result: T; onsuccess: (() => void) | null; onerror: (() => void) | null };
type IndexStore = { get(key: string): StoreRequest<A2AJParquetIndex | undefined>; put(value: A2AJParquetIndex, key: string): StoreRequest<unknown> };
type IndexDatabase = { transaction(name: string, mode: "readonly" | "readwrite"): { objectStore(name: string): IndexStore } };
type IndexedDB = { open(name: string, version: number): StoreRequest<IndexDatabase> & {
  onupgradeneeded: (() => void) | null; result: IndexDatabase & { createObjectStore(name: string): unknown } } };
export function browserA2AJIndexes(): A2AJCorpusSource["indexes"] {
  const memory = new Map<string, A2AJParquetIndex>();
  const indexedDB = (globalThis as { indexedDB?: IndexedDB }).indexedDB;
  const database = indexedDB ? new Promise<IndexDatabase | null>((resolve) => {
    const request = indexedDB.open("a2aj-corpus-indexes", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("indexes");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  }) : Promise.resolve(null);
  const call = async <T>(mode: "readonly" | "readwrite", action: (store: IndexStore) => StoreRequest<T>) => {
    const opened = await database;
    if (!opened) return undefined;
    const request = action(opened.transaction("indexes", mode).objectStore("indexes"));
    return new Promise<T | undefined>((resolve) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  };
  return {
    async get(sha256) {
      return memory.get(sha256) ?? (await call("readonly", (store) => store.get(sha256))) ?? null;
    },
    async put(index) {
      memory.set(index.sha256, index);
      await call("readwrite", (store) => store.put(index, index.sha256));
    },
  };
}
