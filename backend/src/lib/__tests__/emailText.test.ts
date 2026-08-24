import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { extractEmailText, parseEmail } from "../emailText";

const eml = (lines: string[]) => Buffer.from(lines.join("\r\n"), "utf8");

describe("parseEmail", () => {
  it("rejoins quoted-printable soft breaks that split a number", async () => {
    // The failure this whole module exists for: a soft break lands mid-digit,
    // so an undecoded read sees $85,0 and $47,00 instead of the real amounts.
    const message = await parseEmail(
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
    expect(message.body).toContain("$85,000");
    expect(message.body).toContain("$47,000");
    expect(message.body).toContain("—");
    expect(message.body).not.toContain("=E2");
    expect(message.abstentions).toEqual([]);
  });

  it("decodes encoded-word headers", async () => {
    const message = await parseEmail(
      eml([
        "From: =?utf-8?B?TWFyZ2FyZXQgQmVsbG1vcmU=?= <m@example.com>",
        "Subject: =?utf-8?Q?Additional_Information_=E2=80=94_Huang=2DWhitfield?=",
        "",
        "Body.",
      ]),
    );
    expect(message.headers.get("subject")).toBe(
      "Additional Information — Huang-Whitfield",
    );
    expect(message.headers.get("from")).toContain("Margaret Bellmore");
  });

  it("prefers the plain-text rendition of a multipart/alternative", async () => {
    const message = await parseEmail(
      eml([
        "From: a@example.com",
        "Subject: Both",
        'Content-Type: multipart/alternative; boundary="BOUND"',
        "",
        "--BOUND",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>HTML rendition</p>",
        "--BOUND",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Plain rendition",
        "--BOUND--",
      ]),
    );
    expect(message.body).toBe("Plain rendition");
  });

  it("falls back to stripped HTML when there is no plain part", async () => {
    const message = await parseEmail(
      eml([
        "From: a@example.com",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<div>Fee is <b>$5,000</b></div><p>Payable on closing.</p>",
      ]),
    );
    expect(message.body).toContain("Fee is $5,000");
    expect(message.body).toContain("Payable on closing.");
    expect(message.body).not.toContain("<");
  });

  it("names attachments instead of inlining them", async () => {
    const message = await parseEmail(
      eml([
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="X"',
        "",
        "--X",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "See attached.",
        "--X",
        "Content-Type: application/pdf; name=\"wire-transfer.pdf\"",
        "Content-Disposition: attachment; filename=\"wire-transfer.pdf\"",
        "Content-Transfer-Encoding: base64",
        "",
        "JVBERi0xLjQK",
        "--X--",
      ]),
    );
    expect(message.body).toBe("See attached.");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      filename: "wire-transfer.pdf",
      contentType: "application/pdf",
    });
  });

  it("decodes base64 text and a historical charset", async () => {
    const latin1 = Buffer.concat([
      Buffer.from(
        [
          "From: a@example.com",
          "Content-Type: text/plain; charset=iso-8859-1",
          "",
          "",
        ].join("\r\n"),
        "ascii",
      ),
      // "Fee: 5000 EUR — café" in latin-1 (0xE9 = é)
      Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    ]);
    expect((await parseEmail(latin1)).body).toContain("café");

    const b64 = await parseEmail(
      eml([
        "From: a@example.com",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("Retainer is $10,000.", "utf8").toString("base64"),
      ]),
    );
    expect(b64.body).toBe("Retainer is $10,000.");
  });

  it("abstains rather than guessing when the bytes are not an email", async () => {
    const message = await parseEmail(Buffer.from("Just some loose prose.", "utf8"));
    expect(message.abstentions[0]).toMatchObject({ reason: "not_an_email" });
  });

  it("reports an unsupported transfer encoding as a typed abstention", async () => {
    const message = await parseEmail(
      eml([
        "From: a@example.com",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: uuencode",
        "",
        "begin 644 x",
      ]),
    );
    expect(message.abstentions[0]).toMatchObject({
      reason: "unsupported_encoding",
      detail: "uuencode",
    });
  });
});

describe("extractEmailText", () => {
  it("puts provenance headers above the body and flags what is missing", async () => {
    const text = await extractEmailText(
      eml([
        "From: Rachel <rachel@example.com>",
        "To: Margaret <m@example.com>",
        "Date: Mon, 17 Feb 2025 09:43:00 -0000",
        "Subject: Financial notes",
        'Content-Type: multipart/mixed; boundary="B"',
        "",
        "--B",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "The down payment was $90,000.",
        "--B",
        'Content-Type: application/pdf; name="wire.pdf"',
        'Content-Disposition: attachment; filename="wire.pdf"',
        "",
        "%PDF",
        "--B--",
      ]),
    );
    expect(text).toContain("From: Rachel <rachel@example.com>");
    expect(text).toContain("Date: Mon, 17 Feb 2025 09:43:00 -0000");
    expect(text).toContain("Subject: Financial notes");
    expect(text).toContain("The down payment was $90,000.");
    expect(text).toContain("Attachments not included in this file: wire.pdf");
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
