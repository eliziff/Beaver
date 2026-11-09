import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sha256 } from "../hash";
import { structureNative } from "../structureNative";

const emailText = (bytes: Buffer) => structureNative().sourceText(bytes,
  { fileType: "eml", sourceSha256: sha256(bytes) });

const eml = (lines: string[]) => Buffer.from(lines.join("\r\n"), "utf8");

describe("email source text", () => {
  it("rejoins quoted-printable soft breaks that split a number", async () => {
    // The failure this whole module exists for: a soft break lands mid-digit,
    // so an undecoded read sees $85,0 and $47,00 instead of the real amounts.
    const message = await emailText(
      eml([
        "From: Rachel <rachel@example.com>",
        "Subject: Financial notes",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "The balance was approximately $85,0=",
        "00 and the remaining $47,00=",
        "0 came from joint savings =E2=80=94 as discussed.",
      ]),
    );
    expect(message).toContain("$85,000");
    expect(message).toContain("$47,000");
    expect(message).toContain("—");
    expect(message).not.toContain("=E2");
    expect(message).not.toContain("[Not decoded:");
  });

  it("preserves plain prose and reports when it has no email headers", async () => {
    const text = await emailText(Buffer.from("Just some loose prose.", "utf8"));
    expect(text).toContain("Just some loose prose.");
    expect(text).toContain("[Not decoded: not_an_email");
  });

  it("reports an unsupported transfer encoding in the reading", async () => {
    const message = await emailText(
      eml([
        "From: a@example.com",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: uuencode",
        "",
        "begin 644 x",
      ]),
    );
    expect(message).toContain("[Not decoded:");
    expect(message).toContain("unsupported_encoding");
    expect(message).toContain("uuencode");
  });
});


describe("email documents in the library", () => {
  let home: string | null = null;

  afterEach(async () => {
    delete process.env.OPEN_LEGAL_DATA_HOME;
    vi.resetModules();
    if (home) {
      await rm(home, { recursive: true, force: true });
      home = null;
    }
  });

  it("uploads .eml and reads it back decoded, end to end", async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "beaver-eml-"));
    process.env.OPEN_LEGAL_DATA_HOME = home;
    vi.resetModules();
    const store = await import("./support/localDocumentFixtures");
    const tools = await import("./support/localAssistantTools");

    const document = await store.createLocalDocument({
      userId: "00000000-0000-0000-0000-000000000001",
      kind: "file",
      filename: "client-note.eml",
      bytes: Buffer.from(
        [
          "From: Rachel <rachel@example.com>",
          "Date: Mon, 17 Feb 2025 09:43:00 -0000",
          "Subject: Down payment",
          'Content-Type: text/plain; charset="utf-8"',
          "Content-Transfer-Encoding: quoted-printable",
          "",
          "My parents gifted us $85,0=",
          "00 toward the down payment.",
        ].join("\r\n"),
        "utf8",
      ),
    });

    const [read] = await tools.runLocalAssistantTools(
      "00000000-0000-0000-0000-000000000001",
      [{ id: "read-email", name: "Read", input: {
        file_path: `document://${document.id}/version/${document.current_version_id}`,
      } }],
    );
    expect(read.content).toContain("$85,000");
    expect(read.content).not.toContain("$85,0=");
    expect(read.content).toContain("Subject: Down payment");
    await (await import("../relationalDatabase")).closeRelationalDatabase();
  });
});
