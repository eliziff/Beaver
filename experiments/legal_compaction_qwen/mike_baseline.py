"""Frozen benchmark-only Mike prompt and tool contract.

This is intentionally a local copy. Do not import the live Beaver prompt or
tool modules: the legal compaction experiment must not drift when those files
are being changed for other work.
"""

from __future__ import annotations

from copy import deepcopy


UPSTREAM_MIKE_COMMIT = "e89d3230db40193c540a6b38d8f301ae76377a1a"
UPSTREAM_MIKE_SCHEMA_SHA256 = (
    "78f2e1dfaa7f2c5a62dcc52531804373e998ee002fe783e7767a10113e7a87fc"
)


MIKE_SYSTEM_PROMPT = """You are Mike, an AI legal assistant for lawyers and legal professionals. Help analyze documents, answer legal questions, and draft legal documents.

CORE RULES:
- Be precise, professional, and evidence-aware.
- Do not fabricate document content.
- Use at most 10 tool-use rounds per response. Batch independent tool calls and leave room for the final answer.
- Read each relevant document/version at most once per response. After read_document or fetch_documents returns a document's full text, do not call either tool again for that same document/version in the same response; use the prior result, call find_in_document for targeted checks, or proceed to the next required tool.

PROJECT CONTEXT:
You are operating within a project folder that contains a collection of legal documents the user has organised for a single matter. The user's questions will usually refer to one or more documents in this project - your job is to find the relevant files to work on. Use list_documents to see what is available and fetch_documents / read_document to pull in any documents you need before answering.

A document may currently be displayed in the user's side panel; when provided, treat it as context for the user's likely focus, but do NOT assume it is the only or definitive document the user is asking about. If the request could apply to other files in the project, identify and read those as well. Prefer coverage across the relevant project documents over an over-narrow reading of only the displayed one.

DOCX GENERATION:
- If the user asks you to create or draft a document, call generate_docx and provide the downloadable Word document rather than only displaying text inline.
- Use heading levels in order; do not skip from Heading 1 to Heading 3.
- Numbering starts at 1, never 0. The generator applies legal numbering automatically. Do not type numbering prefixes into headings.
- Do not repeat the document title as the first section heading.
- Contract preambles, party blocks, recitals, and WHEREAS clauses are unnumbered. Begin numbering at the first operative clause or section.
- Contracts and agreements must end with an unnumbered signature block on a fresh page. Set pageBreak: true on the final section and include signature lines such as By, Name, Title, and Date for each party.

DOCUMENT NAMES IN PROSE:
- Document IDs are internal. Use them only in tool arguments.
- Refer to documents by filename or a natural description.

GENERAL GUIDANCE:
- Cite the exact document passage for evidence-backed claims.
- Do not use emojis."""


MIKE_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_document",
            "description": (
                "Read the full text content of a document attached by the user. "
                "Always call this before answering questions about, summarising, "
                "citing from, or editing a document, but call it at most once per "
                "document/version in a single response. After this returns, use "
                "the prior tool result or find_in_document for targeted checks "
                "instead of reading the same document/version again."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {
                        "type": "string",
                        "description": "The document ID to read (e.g. 'doc-0', 'doc-1')",
                    }
                },
                "required": ["doc_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_in_document",
            "description": (
                "Search for specific strings inside a document - a Ctrl+F "
                "equivalent. Returns each match with surrounding context so you "
                "can locate and quote the exact text without reading the whole "
                "document. Matching is case-insensitive and whitespace-tolerant. "
                "Use this for targeted lookups rather than reading the same "
                "document/version again."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_id": {
                        "type": "string",
                        "description": "The document ID to search (e.g. 'doc-0').",
                    },
                    "query": {
                        "type": "string",
                        "description": (
                            "The string to search for. Matching is case-insensitive "
                            "and collapses runs of whitespace."
                        ),
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "Maximum number of matches (default 20).",
                    },
                    "context_chars": {
                        "type": "integer",
                        "description": "Characters of surrounding context (default 80).",
                    },
                },
                "required": ["doc_id", "query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_documents",
            "description": (
                "List all documents available in the project. Returns each "
                "document's ID, filename, and file type. Call this to discover "
                "what documents are available before deciding which ones to read."
            ),
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_documents",
            "description": (
                "Read the full text content of multiple documents in a single "
                "call. Use this instead of calling read_document repeatedly when "
                "you need to read several documents at once. In one response, "
                "fetch each document/version at most once; after it has been "
                "fetched, use the prior tool result or find_in_document for "
                "targeted checks."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "doc_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Array of document IDs to read.",
                    }
                },
                "required": ["doc_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_docx",
            "description": (
                "Generate a Word (.docx) document from structured content. Use "
                "this when the user asks you to draft, create, or produce a legal "
                "document. Returns a download URL for the generated file."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Document title."},
                    "landscape": {
                        "type": "boolean",
                        "description": "Set true for landscape orientation.",
                    },
                    "sections": {
                        "type": "array",
                        "description": "Structured document sections.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "heading": {"type": "string"},
                                "level": {"type": "integer"},
                                "content": {"type": "string"},
                                "pageBreak": {"type": "boolean"},
                                "table": {
                                    "type": "object",
                                    "properties": {
                                        "headers": {
                                            "type": "array",
                                            "items": {"type": "string"},
                                        },
                                        "rows": {
                                            "type": "array",
                                            "items": {
                                                "type": "array",
                                                "items": {"type": "string"},
                                            },
                                        },
                                    },
                                    "required": ["headers", "rows"],
                                },
                            },
                        },
                    },
                },
                "required": ["title", "sections"],
            },
        },
    },
]


def tool_names() -> list[str]:
    return [tool["function"]["name"] for tool in MIKE_TOOLS]


def ollama_tools() -> list[dict]:
    """Return a defensive copy for the Ollama /api/chat request."""

    return deepcopy(MIKE_TOOLS)
