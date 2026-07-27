import { describe, expect, it } from "vitest";

import { applyTrackedEdits, extractDocxBodyText } from "../docxTrackedChanges";
import { LOCAL_ASSISTANT_TOOLS } from "../chat/localAssistantTools";
import { renderDocx } from "../chat/tools/documentOps";
import { TOOLS } from "../chat/tools/toolSchemas";

const agreementSections = [
  {
    heading: "Parties and termination",
    content:
      "This Agreement is between {{party_a}} and {{party_b}}.\n{{termination_clause}}",
    contentControls: [
      { tag: "party_a", label: "First party", value: "Acme & <North>" },
      { tag: "party_b", label: "Second party" },
      {
        tag: "termination_clause",
        label: "Termination clause",
        value: "Either party may terminate on 30 days' notice.",
        kind: "clause",
      },
    ],
  },
];

async function documentXml(bytes: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("text");
}

describe("agreement DOCX drafting", () => {
  it("renders deterministic tagged Word content controls without leaking markers", async () => {
    const first = await renderDocx("Service Agreement", agreementSections);
    const second = await renderDocx("Service Agreement", agreementSections);
    if ("error" in first) throw new Error(first.error);
    if ("error" in second) throw new Error(second.error);

    const xml = await documentXml(first.bytes);
    const secondXml = await documentXml(second.bytes);
    const ids = [...xml.matchAll(/<w:id w:val="(\d+)"\/>/gu)].map(
      (match) => match[1],
    );
    const secondIds = [...secondXml.matchAll(/<w:id w:val="(\d+)"\/>/gu)].map(
      (match) => match[1],
    );

    expect(xml.match(/<w:sdt>/gu)).toHaveLength(3);
    expect(xml).toContain('<w:tag w:val="party_a"/>');
    expect(xml).toContain('<w:alias w:val="Termination clause"/>');
    expect(xml).toContain("Acme &amp; &lt;North&gt;");
    expect(xml).not.toContain("{{party_a}}");
    expect(new Set(ids).size).toBe(3);
    expect(secondIds).toEqual(ids);
    await expect(extractDocxBodyText(first.bytes)).resolves.toContain(
      "Either party may terminate on 30 days' notice.",
    );

    const edit = await applyTrackedEdits(first.bytes, [
      {
        find: "Acme & <North>",
        replace: "Changed party",
        context_before: "This Agreement is between ",
        context_after: " and ",
      },
    ]);
    expect(edit.changes).toEqual([]);
    expect(edit.errors[0]?.reason).toContain("Word content control");
  });

  it("fails closed when a declared control is not placed", async () => {
    const rendered = await renderDocx("Agreement", [
      {
        content: "No marker appears here.",
        contentControls: [{ tag: "effective_date", label: "Effective date" }],
      },
    ]);

    expect(rendered).toEqual({
      error: expect.stringContaining(
        'Content control "effective_date" has no matching',
      ),
    });
  });

  it("fails closed on malformed control markers", async () => {
    const rendered = await renderDocx("Agreement", [
      {
        content: "This starts on {{Effective Date}}.",
      },
    ]);

    expect(rendered).toEqual({
      error: expect.stringContaining("{{lowercase_tag}}"),
    });
  });

  it("makes agreement artifacts and controls explicit in both tool catalogs", () => {
    const generated = TOOLS.find(
      (tool) => tool.function.name === "generate_docx",
    )!;
    const local = LOCAL_ASSISTANT_TOOLS.find(
      (tool) => tool.function.name === "library_create_docx",
    )!;
    const sections = generated.function.parameters.properties.sections as {
      items: { properties: Record<string, unknown> };
    };

    expect(generated.function.description).toContain(
      "default output when the user asks to draft an agreement",
    );
    expect(sections.items.properties).toHaveProperty("contentControls");
    expect(local.function.description).toContain(
      "modern Word content controls",
    );
  });
});
