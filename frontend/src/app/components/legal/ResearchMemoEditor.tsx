import { isResearchSource, researchHighlightCount } from "@/app/lib/researchFiles";
import { useEffect, useRef, useState } from "react";
import { Node, type Editor } from "@tiptap/core";
import { EditorContent, NodeViewWrapper, ReactNodeViewRenderer, useEditor, useEditorState, type NodeViewProps } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import { Bold, Italic, Underline, List, ListOrdered, Heading2, Quote, Table2, Undo2, Redo2 } from "lucide-react";
import { CitationPill } from "@/app/components/assistant/message/MarkdownContent";
import { citationPillParts } from "@/app/components/assistant/message/CitationSources";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { RESEARCH_SOURCE_DRAG, RESEARCH_SOURCE_REFERENCE_DRAG } from "./ResearchLabelPicker";
import { citationMarkdown, memoCitation, RESEARCH_PASSAGE_DRAG, RESEARCH_PASSAGE_REFERENCE_DRAG, type MemoSourceReference } from "./researchMemo";
import { getResearchCitation, getResearchItems } from "@/app/lib/api/researchFiles";
import type { ResearchEvidence, ResearchFile } from "@/app/lib/researchFiles";

function CitationView({ node, extension }: NodeViewProps) {
  const citation = memoCitation(node.attrs.href, node.attrs.label);
  const target = safeAssistantUrl(new URLSearchParams(String(node.attrs.href).split("?")[1]).get("external_url"), { relative: false }) ?? node.attrs.href;
  return <NodeViewWrapper as="span" className="inline" contentEditable={false}>
    {citation ? <CitationPill citation={citation} onClick={() => extension.options.onOpen(target)} /> : node.attrs.label}
  </NodeViewWrapper>;
}

const MemoCitation = Node.create({
  name: "memoCitation", group: "inline", inline: true, atom: true, selectable: true,
  addOptions: () => ({ onOpen: (href: string) => { window.open(href, "_blank", "noopener,noreferrer"); } }),
  addAttributes: () => ({ href: { default: "" }, label: { default: "Source" } }),
  parseHTML: () => [{ tag: "a[data-memo-citation]", getAttrs: (element) => ({ href: element.getAttribute("href"), label: element.textContent }) }],
  renderHTML: ({ node }) => ["a", { "data-memo-citation": "", href: node.attrs.href }, node.attrs.label],
  renderMarkdown: (node) => citationMarkdown(node.attrs?.label ?? "Source", node.attrs?.href ?? ""),
  addNodeView: () => ReactNodeViewRenderer(CitationView),
});

const MemoLink = Link.extend({
  parseMarkdown: (token, helpers) => memoCitation(String(token.href ?? ""))
    ? { type: "memoCitation", attrs: { href: token.href, label: token.text } }
    : helpers.applyMark("link", helpers.parseInline(token.tokens ?? []), { href: token.href, title: token.title ?? null }),
});
export const memoExtensions = [StarterKit.configure({ link: false }), MemoLink.configure({ openOnClick: false }),
  TableKit.configure({ table: { resizable: false } }), Markdown, MemoCitation];

function Toolbar({ editor, onCite }: { editor: Editor; onCite: () => void }) {
  const active = useEditorState({ editor, selector: ({ editor: current }) => ({
    bold: current.isActive("bold"), italic: current.isActive("italic"), underline: current.isActive("underline"),
    heading: current.isActive("heading"), bullet: current.isActive("bulletList"), ordered: current.isActive("orderedList"),
    table: current.isActive("table"), undo: current.can().undo(), redo: current.can().redo(),
  }) });
  const actions = [
    { label: "Bold", icon: Bold, pressed: active.bold, run: () => editor.chain().focus().toggleBold().run() },
    { label: "Italic", icon: Italic, pressed: active.italic, run: () => editor.chain().focus().toggleItalic().run() },
    { label: "Underline", icon: Underline, pressed: active.underline, run: () => editor.chain().focus().toggleUnderline().run() },
    { label: "Heading", icon: Heading2, pressed: active.heading, run: () => editor.chain().focus().toggleHeading({ level: 2 }).run() },
    { label: "Bullet list", icon: List, pressed: active.bullet, run: () => editor.chain().focus().toggleBulletList().run() },
    { label: "Numbered list", icon: ListOrdered, pressed: active.ordered, run: () => editor.chain().focus().toggleOrderedList().run() },
    { label: "Undo", icon: Undo2, disabled: !active.undo, run: () => editor.chain().focus().undo().run() },
    { label: "Redo", icon: Redo2, disabled: !active.redo, run: () => editor.chain().focus().redo().run() },
  ];
  return <div role="group" aria-label="Memo formatting" className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-gray-200 py-1">
    {actions.map(({ label, icon: Icon, pressed, disabled, run }) => <button key={label} type="button" title={label}
      aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={run}
      className="grid size-8 place-items-center rounded text-gray-600 hover:bg-gray-100 aria-pressed:bg-gray-200 aria-pressed:text-gray-950 disabled:opacity-30 focus-visible:outline focus-visible:outline-2"><Icon className="size-3.5" /></button>)}
    <button type="button" title="Insert citation" aria-label="Insert citation" onClick={onCite}
      className="grid size-8 place-items-center rounded text-gray-600 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2"><Quote className="size-3.5" /></button>
    <ActionMenu label="Table" items={active.table ? [
      { label: "Add row", onSelect: () => { editor.chain().focus().addRowAfter().run(); } },
      { label: "Add column", onSelect: () => { editor.chain().focus().addColumnAfter().run(); } },
      { label: "Delete row", onSelect: () => { editor.chain().focus().deleteRow().run(); } },
      { label: "Delete column", onSelect: () => { editor.chain().focus().deleteColumn().run(); } },
      { label: "Delete table", onSelect: () => { editor.chain().focus().deleteTable().run(); } },
    ] : [{ label: "Insert table", onSelect: () => { editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run(); } }]}
      triggerClassName="grid size-8 place-items-center rounded text-gray-600 hover:bg-gray-100"><Table2 className="size-3.5" /></ActionMenu>
  </div>;
}

export default function ResearchMemoEditor({ file, value, onChange, onOpenCitation, readOnly = false, onResolveReference, onCitationError }: {
  file: ResearchFile; value: string; onChange?: (markdown: string) => void; onOpenCitation: (href: string) => void;
  readOnly?: boolean;
  onResolveReference?: (reference: MemoSourceReference) => Promise<string | null>;
  onCitationError?: (message: string) => void;
}) {
  const openCitation = useRef(onOpenCitation); openCitation.current = onOpenCitation;
  const [citing, setCiting] = useState<null | { sourceId?: string }>(null);
  const [passages, setPassages] = useState<ResearchEvidence[]>([]);
  const editor = useEditor({ extensions: [...memoExtensions.filter((extension) => extension.name !== "memoCitation"),
    MemoCitation.configure({ onOpen: (href: string) => openCitation.current(href) })], content: value, contentType: "markdown",
    shouldRerenderOnTransaction: false, editable: !readOnly,
    editorProps: { attributes: { role: "textbox", "aria-label": "Workspace memo", "aria-multiline": "true", "aria-readonly": String(readOnly),
      class: "min-h-36 p-3 outline-none font-serif text-base leading-7 text-gray-950 [&_p]:my-2 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-gray-300 [&_td]:p-2 [&_th]:border [&_th]:border-gray-300 [&_th]:bg-gray-50 [&_th]:p-2 [&_blockquote]:border-l-2 [&_blockquote]:pl-3 [&_a]:underline" },
      handleDrop: (view, event) => {
        const transfer = event.dataTransfer;
        if (readOnly || !transfer?.types.some((type) => [RESEARCH_SOURCE_DRAG, RESEARCH_PASSAGE_DRAG,
          RESEARCH_SOURCE_REFERENCE_DRAG, RESEARCH_PASSAGE_REFERENCE_DRAG].includes(type))) return false;
        event.preventDefault(); event.stopPropagation();
        const position = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        const insert = (href: string) => {
          if (view.isDestroyed) return;
          const source = memoCitation(href); if (!source) return;
          const parts = citationPillParts(source), node = view.state.schema.nodes.memoCitation.create({
            href, label: `${parts.styleOfCause ?? ""}${parts.rest}` });
          view.dispatch(view.state.tr.insert(Math.min(position ?? view.state.selection.from, view.state.doc.content.size), node));
          view.focus();
        };
        if (transfer.types.includes(RESEARCH_SOURCE_REFERENCE_DRAG) || transfer.types.includes(RESEARCH_PASSAGE_REFERENCE_DRAG)) {
          try {
            const raw = transfer.getData(RESEARCH_PASSAGE_REFERENCE_DRAG), reference: MemoSourceReference = raw ? JSON.parse(raw)
              : { reference: JSON.parse(transfer.getData(RESEARCH_SOURCE_REFERENCE_DRAG)) };
            if (!reference?.reference || typeof reference.reference.id !== "string") return true;
            if (onResolveReference) void onResolveReference(reference).then((href) => { if (href) insert(href); });
          } catch { /* Ignore an unrelated or malformed drag. */ }
          return true;
        }
        let passage: ResearchEvidence | undefined;
        try { const raw = transfer.getData(RESEARCH_PASSAGE_DRAG); if (raw) passage = JSON.parse(raw); } catch { return true; }
        const source = file.state.sources[passage?.sourceId ?? transfer.getData(RESEARCH_SOURCE_DRAG)];
        if (!source || passage && (!passage.receipt?.evidence_id || !passage.receipt.locator)) return true;
        void getResearchCitation(file.document.id, source.id, passage?.receipt.evidence_id)
          .then(({ href }) => insert(href)).catch(() => onCitationError?.("Could not add this citation. Try again.")); return true;
      } },
    onUpdate: ({ editor: current }) => onChange?.(current.getMarkdown()),
  });
  useEffect(() => { if (editor && value !== editor.getMarkdown()) editor.commands.setContent(value, { contentType: "markdown", emitUpdate: false }); }, [editor, value]);
  useEffect(() => {
    const sourceId = citing?.sourceId;
    if (!sourceId) return setPassages([]);
    let live = true;
    void getResearchItems(file.document.id, { kind: "passages", sourceId, limit: 200 })
      .then((page) => { if (live) setPassages(page.items.flatMap((item) => item.kind === "passage" ? [item.value] : [])); })
      .catch(() => onCitationError?.("Could not load saved passages."));
    return () => { live = false; };
  }, [citing?.sourceId, file.document.id, onCitationError]);
  if (!editor) return null;
  const sources = Object.values(file.state.sources).filter(isResearchSource);
  const sourceLabel = (id: string) => { const reference = file.state.sources[id]?.reference;
    return reference?.title || reference?.citation || id; };
  const cite = async (sourceId: string, evidenceId?: string) => {
    try {
      const { href } = await getResearchCitation(file.document.id, sourceId, evidenceId);
      const source = memoCitation(href); if (!source) return;
      const parts = citationPillParts(source);
      editor.chain().focus().insertContent({ type: "memoCitation", attrs: {
        href, label: `${parts.styleOfCause ?? ""}${parts.rest}` } }).run();
      setCiting(null);
    } catch { onCitationError?.("Could not add this citation. Try again."); }
  };
  return <>{!readOnly && <Toolbar editor={editor} onCite={() => setCiting({})} />}
    <EditorContent editor={editor} className="min-h-0 flex-1 overflow-auto bg-white" />
    <SearchableChoiceModal open={!!citing} onClose={() => setCiting(null)} closeOnSelect={false} value={null}
      title={citing?.sourceId ? sourceLabel(citing.sourceId) : "Insert citation"}
      options={citing?.sourceId
        ? [{ value: "", label: "Whole source" }, ...passages.map((item) => ({ value: item.receipt.evidence_id,
            label: item.receipt.locator.label, description: item.receipt.span_text ?? undefined }))]
        : sources.map((source) => ({ value: source.id, label: sourceLabel(source.id),
            description: researchHighlightCount(source) ? `${researchHighlightCount(source)} saved` : undefined }))}
      onChange={(id) => { if (id === null) return;
        if (citing?.sourceId) void cite(citing.sourceId, id || undefined);
        else setCiting({ sourceId: id }); }} />
  </>;
}
