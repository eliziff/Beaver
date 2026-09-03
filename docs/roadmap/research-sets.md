# Research files

Status: implemented

Research is an ordinary movable `.research.md` Library file, personal or
project-scoped. It stores nested colour labels, canonical source references,
verified evidence receipts, optional notes, and existing query receipts. Source
bodies stay with their providers.

Humans and models use the same file operations. Chat evidence remains chat-local
until explicitly saved, with search receipts optional. Reading a file exposes a
bounded index; passage text and prior searches are restored only when requested,
so another model can resume the work without flooding its context.
