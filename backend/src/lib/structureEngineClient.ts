import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { constants as osConstants, getPriority, setPriority } from "node:os";
import path from "node:path";
import { isolatedProcessEnv } from "./subprocessEnv";

import {
  STRUCTURE_CAPABILITIES,
  STRUCTURE_EVIDENCE_SCHEMA,
  STRUCTURE_RESULT_SCHEMA,
  STRUCTURE_SIDECAR_PROTOCOL,
  documentScalarOffsets,
  structureWireShape as shape,
  validateStructureGraph,
  type StructureCapability,
  type StructureEvidenceV1,
  type StructureInputIdentity,
  type StructureResultItem,
} from "./structureWire";

type Pending = {
  requestId: string; inputs: StructureInputIdentity[]; timer: NodeJS.Timeout;
  resolve: (items: StructureResultItem[]) => void; reject: (error: Error) => void;
};
type StructureHello = {
  max_documents: number; max_bytes: number; capabilities: StructureCapability[];
};
export type StructureClientOptions = {
  expectedEngineSha256: string;
  requiredCapabilities: readonly StructureCapability[];
  binary?: string; arguments?: string[]; cwd?: string;
  env?: NodeJS.ProcessEnv; timeoutMs?: number; requireBelowNormalPriority?: boolean;
};
export type StructurePriorityReceipt = Readonly<{
  class: "BELOW_NORMAL"; parent_pid: number; child_pid: number;
  parent_priority: number; child_priority: number;
}>;

export function setBelowNormalProcessPriority() {
  const wanted = osConstants.priority.PRIORITY_BELOW_NORMAL;
  setPriority(0, wanted);
  const actual = getPriority(0);
  if (actual !== wanted) throw new Error(`Process priority is ${actual}, expected BELOW_NORMAL (${wanted})`);
  return { pid: process.pid, priority: actual };
}

function priorityReceipt(childPid: number): StructurePriorityReceipt {
  const wanted = osConstants.priority.PRIORITY_BELOW_NORMAL;
  const parentPriority = getPriority(process.pid);
  const childPriority = getPriority(childPid);
  if (parentPriority !== wanted || childPriority !== wanted) {
    throw new Error(`Structure sidecar priority is parent=${parentPriority}, child=${childPriority}; expected BELOW_NORMAL (${wanted})`);
  }
  return { class: "BELOW_NORMAL", parent_pid: process.pid, child_pid: childPid,
    parent_priority: parentPriority, child_priority: childPriority };
}

export function legalStructureBinary(env = process.env) {
  if (env.LEGAL_STRUCTURE_BINARY?.trim()) return env.LEGAL_STRUCTURE_BINARY.trim();
  const root = path.resolve(
    env.LEGALPDF_ENGINE_ROOT?.trim() || path.join(__dirname, "../../../legal-pdf-parser"),
  );
  const managed = path.join(
    root,
    "target",
    "release",
    process.platform === "win32" ? "legal-structure.exe" : "legal-structure",
  );
  return existsSync(managed) ? managed : "legal-structure";
}
export type StructureEngineClient = {
  limits: Readonly<{ max_documents: number; max_bytes: number }>;
  capabilities: readonly StructureCapability[];
  priority: StructurePriorityReceipt | null;
  derive(documents: readonly StructureEvidenceV1[], scalarLengths?: readonly number[]): Promise<StructureResultItem[]>;
  stats(): Readonly<{ batches: number; documents: number; request_bytes: number }>;
  alive(): boolean; stop(): void;
};

const HEX = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;
export async function startStructureEngineClient(options: StructureClientOptions): Promise<StructureEngineClient> {
  if (!HEX.test(options.expectedEngineSha256)) throw new Error("expectedEngineSha256 must be a lowercase SHA-256");
  if (!options.requiredCapabilities.length || new Set(options.requiredCapabilities).size !== options.requiredCapabilities.length ||
      options.requiredCapabilities.some((value) => !STRUCTURE_CAPABILITIES.includes(value))) {
    throw new Error("requiredCapabilities must be a unique, nonempty recognized capability set");
  }
  if (options.requireBelowNormalPriority) {
    const wanted = osConstants.priority.PRIORITY_BELOW_NORMAL;
    if (getPriority(process.pid) !== wanted) throw new Error("Parent process must be BELOW_NORMAL before spawning a structure sidecar");
  }
  const child = spawn(options.binary ?? legalStructureBinary(), options.arguments ?? [], {
    cwd: options.cwd, env: options.env ?? isolatedProcessEnv(["LEGAL_STRUCTURE_*"]),
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let priority: StructurePriorityReceipt | null = null;
  try {
    if (options.requireBelowNormalPriority) {
      if (child.pid === undefined) throw new Error("Structure sidecar has no process ID");
      priority = priorityReceipt(child.pid);
    }
  } catch (error) {
    child.kill();
    throw error;
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let chunks: Buffer[] = [], byteCount = 0, stderr = "", closed: Error | null = null;
  let hello: StructureHello | null = null;
  let pending: Pending | null = null, requestNumber = 0;
  let batches = 0, documentsSent = 0, requestBytes = 0;
  let readyResolve!: (value: StructureHello) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<StructureHello>((resolve, reject) => {
    readyResolve = resolve; readyReject = reject;
  });
  const fatal = (reason: string, kill = true) => {
    if (closed) return;
    const detail = stderr.trim().slice(-1_000);
    closed = new Error(`Structure sidecar ${reason}${detail ? `: ${detail}` : ""}`);
    readyReject(closed);
    if (pending) { clearTimeout(pending.timer); pending.reject(closed); pending = null; }
    if (kill && child.exitCode === null) child.kill();
  };
  const consume = (bytes: Buffer) => {
    if (bytes.includes(0x0d)) throw new Error("used forbidden CR framing");
    const value = JSON.parse(decoder.decode(bytes)) as unknown;
    if (!hello) {
      const raw = shape(value, ["type", "protocol", "evidence_schema", "result_schema", "engine_sha256", "capabilities", "max_documents", "max_bytes"]);
      const capabilities = raw.capabilities;
      if (raw.type !== "hello" || raw.protocol !== STRUCTURE_SIDECAR_PROTOCOL || raw.evidence_schema !== STRUCTURE_EVIDENCE_SCHEMA ||
          raw.result_schema !== STRUCTURE_RESULT_SCHEMA || raw.engine_sha256 !== options.expectedEngineSha256 ||
          !Array.isArray(capabilities) || !capabilities.length || new Set(capabilities).size !== capabilities.length ||
          !capabilities.every((item): item is StructureCapability =>
            typeof item === "string" && STRUCTURE_CAPABILITIES.includes(item as StructureCapability)) ||
          options.requiredCapabilities.some((item) => !capabilities.includes(item)) ||
          !Number.isSafeInteger(raw.max_documents) || Number(raw.max_documents) <= 0 ||
          !Number.isSafeInteger(raw.max_bytes) || Number(raw.max_bytes) <= 0) throw new Error("sent an incompatible hello");
      hello = { max_documents: Number(raw.max_documents), max_bytes: Number(raw.max_bytes), capabilities };
      readyResolve(hello); return;
    }
    if (!pending) throw new Error("sent an unsolicited line");
    const batch = shape(value, ["type", "request_id", "items"]);
    if (batch.type !== "result_batch" || batch.request_id !== pending.requestId || !Array.isArray(batch.items) ||
        batch.items.length !== pending.inputs.length) throw new Error("sent an invalid result_batch envelope");
    const items = batch.items.map((raw, index): StructureResultItem => {
      const input = pending!.inputs[index];
      const item = shape(raw, ["id", "ok"], ["result", "error"]);
      if (item.id !== input.id || typeof item.ok !== "boolean") throw new Error("sent unordered or uncorrelated result items");
      if (item.ok) return { id: input.id, ok: true, result: validateStructureGraph(shape(item, ["id", "ok", "result"]).result, input) };
      const error = shape(shape(item, ["id", "ok", "error"]).error, ["code", "message"]);
      if (typeof error.code !== "string" || typeof error.message !== "string") throw new Error("sent an invalid error item");
      return { id: input.id, ok: false, error: { code: error.code, message: error.message } };
    });
    clearTimeout(pending.timer); const resolve = pending.resolve; pending = null; resolve(items);
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
  child.once("error", (error) => fatal(`failed to start: ${error.message}`, false));
  child.once("close", (code) => fatal(byteCount ? "closed with a truncated response" : `exited${code === null ? "" : ` (${code})`}`, false));
  child.stdout.on("data", (chunk: Buffer) => {
    if (closed) return;
    let start = 0;
    for (let at = chunk.indexOf(0x0a); at >= 0; at = chunk.indexOf(0x0a, start)) {
      const part = chunk.subarray(start, at); chunks.push(part); byteCount += part.length;
      if (byteCount > MAX_RESPONSE_BYTES) return fatal("response line exceeded 256 MiB");
      const line = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, byteCount);
      chunks = []; byteCount = 0;
      try { consume(line); } catch (error) { return fatal(error instanceof Error ? error.message : String(error)); }
      start = at + 1;
    }
    const tail = chunk.subarray(start);
    if (tail.length) { chunks.push(tail); byteCount += tail.length; }
    if (byteCount > MAX_RESPONSE_BYTES) fatal("response line exceeded 256 MiB");
  });
  const helloTimer = setTimeout(() => fatal("hello timed out"), timeoutMs);
  const readyHello = await ready.finally(() => clearTimeout(helloTimer));
  const limits = { max_documents: readyHello.max_documents, max_bytes: readyHello.max_bytes };

  const send = (wire: string, inputs: StructureInputIdentity[], requestId: string) => new Promise<StructureResultItem[]>((resolve, reject) => {
    if (closed) return reject(closed);
    const timer = setTimeout(() => fatal(`${requestId} timed out`), timeoutMs);
    pending = { requestId, inputs, resolve, reject, timer };
    child.stdin.write(`${wire}\n`, (error) => { if (error) fatal(`write failed: ${error.message}`); });
  });
  const deriveNow = async (documents: readonly StructureEvidenceV1[], scalarLengths?: readonly number[]) => {
    const seen = new Set<string>(), items: StructureResultItem[] = [];
    if (scalarLengths && (scalarLengths.length !== documents.length || scalarLengths.some((value, index) =>
      !Number.isSafeInteger(value) || value < 0 || value > documents[index].text.length))) {
      throw new Error("Invalid scalar-length sidecar metadata");
    }
    let cursor = 0, candidate: { document: StructureEvidenceV1; json: string; bytes: number;
      scalarLength: number } | undefined;
    for (const document of documents) {
      if (!document.document_id || seen.has(document.document_id)) throw new Error("Structure evidence document IDs must be unique and nonempty");
      seen.add(document.document_id);
    }
    while (cursor < documents.length) {
      const requestId = `ts-${++requestNumber}`;
      const prefix = `{"type":"derive_batch","request_id":${JSON.stringify(requestId)},"documents":[`;
      const selected: Array<NonNullable<typeof candidate>> = []; let bodyBytes = 0;
      while (cursor < documents.length && selected.length < limits.max_documents) {
        if (!candidate) {
          const document = documents[cursor], json = JSON.stringify(document);
          if (json.includes("\n") || json.includes("\r")) throw new Error("Structure evidence serialized with a raw newline");
          candidate = { document, json, bytes: Buffer.byteLength(json),
            scalarLength: scalarLengths?.[cursor] ?? documentScalarOffsets(document.text).scalarLength };
        }
        if (Buffer.byteLength(prefix) + bodyBytes + (selected.length ? 1 : 0) + candidate.bytes + 2 > limits.max_bytes) break;
        selected.push(candidate); bodyBytes += candidate.bytes + (selected.length > 1 ? 1 : 0); candidate = undefined; cursor += 1;
      }
      if (!selected.length) throw new Error(`Structure evidence ${candidate!.document.document_id} exceeds max_bytes`);
      const inputs = selected.map(({ document, scalarLength }) => ({
        id: document.document_id, textHash: document.text_sha256,
        sourceHash: document.source_sha256,
        scalarLength,
      }));
      const wire = `${prefix}${selected.map(({ json }) => json).join(",")}]}`;
      batches += 1; documentsSent += selected.length; requestBytes += Buffer.byteLength(wire) + 1;
      items.push(...await send(wire, inputs, requestId));
    }
    return items;
  };
  let queue = Promise.resolve();
  return {
    limits, capabilities: readyHello.capabilities, priority,
    derive(documents, scalarLengths) {
      const result = queue.then(() => deriveNow(documents, scalarLengths));
      queue = result.then(() => undefined, () => undefined); return result;
    },
    stats: () => ({ batches, documents: documentsSent, request_bytes: requestBytes }),
    alive: () => !closed,
    stop: () => fatal("was stopped"),
  };
}
