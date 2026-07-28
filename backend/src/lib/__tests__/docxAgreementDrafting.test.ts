import { describe, expect, it } from "vitest";

import { applyTrackedEdits, extractDocxBodyText } from "../docxTrackedChanges";
import { LOCAL_ASSISTANT_TOOLS } from "../chat/localAssistantTools";
import { buildSystemPrompt } from "../chat/prompts";
import { renderMarkdownDocx } from "../chat/tools/documentOps";
import { PROJECT_EXTRA_TOOLS, TOOLS } from "../chat/tools/toolSchemas";
import { SYSTEM_WORKFLOWS } from "../systemWorkflows";

const agreementMarkdown = `# Parties and termination

This Agreement is between {{party_a}} and {{party_b}}.

{{termination_clause}}`;
const agreementFields = [
  { id: "party_a", value: "Acme & <North>" },
  { id: "party_b", value: "[Second party]" },
  {
    id: "termination_clause",
    value: "Either party may terminate on 30 days' notice.",
  },
];

async function documentXml(bytes: Buffer) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(bytes);
  return zip.file("word/document.xml")!.async("text");
}

describe("agreement DOCX drafting", () => {
  it("renders deterministic tagged Word content controls without leaking markers", async () => {
    const first = await renderMarkdownDocx(
      "Service Agreement",
      agreementMarkdown,
      agreementFields,
    );
    const second = await renderMarkdownDocx(
      "Service Agreement",
      agreementMarkdown,
      agreementFields,
    );
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

  it("normalizes weak-model field ids before rendering native controls", async () => {
    const rendered = await renderMarkdownDocx(
      "Lease",
      "Tenant: **{{ Tenant Name }}**.",
      [{ id: " Tenant Name ", value: "Alex" }],
    );
    if ("error" in rendered) throw new Error(rendered.error);

    const xml = await documentXml(rendered.bytes);
    expect(xml).toContain('<w:tag w:val="tenant_name"/>');
    expect(xml).toContain("Alex");
  });

  it("exposes concise semantic Markdown in both tool catalogs", () => {
    const generated = TOOLS.find(
      (tool) => tool.function.name === "generate_docx",
    )!;
    const editor = TOOLS.find(
      (tool) => tool.function.name === "edit_document",
    )!;
    const local = LOCAL_ASSISTANT_TOOLS.find(
      (tool) => tool.function.name === "library_create_docx",
    )!;
    const properties = generated.function.parameters.properties as Record<
      string,
      unknown
    >;

    expect(generated.function.description).toContain("semantic Markdown");
    expect(generated.function.parameters.required).toEqual([
      "title",
      "markdown",
    ]);
    expect(properties).toHaveProperty("markdown");
    expect(properties).toHaveProperty("fields");
    expect(properties).toHaveProperty("sources");
    expect(properties).not.toHaveProperty("sections");
    expect(local.function.description).toContain("local Library");
    expect(editor.function.description).toContain(
      "return the edited Word artifact",
    );
    expect(editor.function.description).toContain(
      "instead of replying with proposed or suggested changes",
    );
  });

  it("uses structure-aware reads instead of the removed copy/edit path", () => {
    const reader = TOOLS.find(
      (tool) => tool.function.name === "read_document",
    )!;
    const localReader = LOCAL_ASSISTANT_TOOLS.find(
      (tool) => tool.function.name === "library_read",
    )!;
    const readerMode = (
      reader.function.parameters.properties as Record<
        string,
        { enum?: string[] }
      >
    ).mode;
    const localMode = (
      localReader.function.parameters.properties as Record<
        string,
        { enum?: string[] }
      >
    ).mode;
    const toolNames = [...TOOLS, ...PROJECT_EXTRA_TOOLS].map(
      (tool) => tool.function.name,
    );
    const workflow = SYSTEM_WORKFLOWS.find(
      (item) => item.id === "builtin-draft-from-template",
    );
    const prompt = buildSystemPrompt(false);

    expect(readerMode.enum).toEqual(["text", "drafting"]);
    expect(localMode.enum).toEqual(["text", "drafting"]);
    expect(toolNames).not.toContain("replicate_document");
    expect(workflow?.skill_md).toContain("mode");
    expect(workflow?.skill_md).not.toContain("file-copy");
    expect(prompt).toContain('mode "drafting"');
    expect(prompt).not.toContain("pageBreak: true");
  });
});
