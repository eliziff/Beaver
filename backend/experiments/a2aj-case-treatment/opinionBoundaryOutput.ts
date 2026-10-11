import { compileStructure, evidenceNamesPerson, type AnchoredSpan, type CaseMaterial, type StructureCompilation } from "./contract";

type Span = [number, number];
export type JudicialNames = {
  names: Array<{ name: string; kind: 0 | 1; evidence: Span }>;
  panel: number[];
  nonparticipants: number[];
  opinions: Array<{ writers: Array<{ person: number; evidence: Span }>; joins: Array<{ person: number; partial: boolean; evidence: Span }> }>;
};
type Person = { n: string; k: 0 | 1; e: number };
type Link = { i: number; e: number };
type Join = Link & { r: 0 | 1 };
type Edge = { s: number; e: number; q: string | null; r: string | null };
type Opinion = Edge & { w: Link[]; j: Join[] };
type Response = { k: 0 | 1 | 2; n: Person[]; p: number[]; x: number[]; o: Opinion[]; ev: number | null };

export function boundaryOutputSchema(lines: number) {
  const unit = { type: "integer", minimum: 1, maximum: lines };
  const person = { type: "integer", minimum: 0, maximum: 39 };
  const nullableQuote = { type: ["string", "null"], maxLength: 300 };
  const link = { type: "object", additionalProperties: false, properties: { i: person, e: unit }, required: ["i", "e"] };
  return { type: "object", additionalProperties: false, properties: {
    k: { type: "integer", enum: [0, 1, 2] },
    n: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false,
      properties: { n: { type: "string", minLength: 1, maxLength: 100 }, k: { type: "integer", enum: [0, 1] }, e: unit }, required: ["n", "k", "e"] } },
    p: { type: "array", maxItems: 40, items: person }, x: { type: "array", maxItems: 40, items: person },
    o: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false,
      properties: { s: unit, e: unit, q: nullableQuote, r: nullableQuote,
        w: { type: "array", maxItems: 40, items: link },
        j: { type: "array", maxItems: 40, items: { ...link, properties: { i: person, e: unit, r: { type: "integer", enum: [0, 1] } }, required: ["i", "e", "r"] } } },
      required: ["s", "e", "q", "r", "w", "j"] } },
    ev: { anyOf: [unit, { type: "null" }] },
  }, required: ["k", "n", "p", "x", "o", "ev"] };
}

export const BOUNDARY_INSTRUCTIONS = `Extract every independently reasoned judicial opinion and explicitly supported judge relationships from this complete decision.
Return k=0 for published reasons, k=1 for a reported outcome without published judicial reasons, or k=2 for unresolved structure. For k=1/2, o is empty; ev is an evidence unit ID for k=1 and null otherwise.
Source units have numeric IDs. Each opinion has s/e for its first/last substantive units, including its conclusion and disposition. q/r are null to use the whole start/end unit; only if that edge falls inside a unit, copy a short exact unique start/end quote there. Exclude headnotes, procedural summaries, counsel, signatures and publisher material. A bare joinder, order, or disposition line is not an opinion. Keep short independently reasoned oral reasons and all separate reasons; quoted lower-court reasons are not separate opinions.
n lists only needed judge/collective names: n is the name as supported by the source, k=0 judge or 1 collective, e is a unit containing name evidence. Refer to these by zero-based array index; p lists participating panel judges and x nonparticipants. Keep unknown panel/writers empty; do not infer joins from co-sitting or names in cited decisions. Each opinion's w lists writers with i=name index,e=authorship evidence unit. Its j lists judges joining reasons with i,e and r=0 full or 1 partial join. A named collective goes in w, never p. Record joint writers, explicit joins and qualifications. Do not extract votes, citation treatments, summaries, or explanations. Read the whole source.`;

function exactKeys(value: unknown, keys: string[]) {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function compileRichOutput(raw: unknown, material: CaseMaterial): {
  state: number; spans: Span[]; names: JudicialNames | null; compilation: StructureCompilation | null; errors: string[];
} {
  const fail = (errors: string[]) => ({ state: 4, spans: [], names: null, compilation: null, errors });
  if (!exactKeys(raw, ["k", "n", "p", "x", "o", "ev"])) return fail(["invalid boundary object fields"]);
  const value = raw as Response, errors: string[] = [];
  if (![0, 1, 2].includes(value.k) || ![value.n, value.p, value.x, value.o].every((list) => Array.isArray(list) && list.length <= 40)) return fail(["invalid status or lists"]);
  const unit = (id: unknown): AnchoredSpan | null => {
    if (!Number.isSafeInteger(id) || Number(id) < 1 || Number(id) > material.source_lines.length) { errors.push(`invalid source unit ${id}`); return null; }
    const line = material.source_lines[Number(id) - 1], text = material.text.slice(line.start, line.end).trim();
    return { start_line: Number(id), end_line: Number(id), start_quote: text, end_quote: text };
  };
  const offset = (id: number): Span => {
    const line = material.source_lines[id - 1], text = material.text.slice(line.start, line.end);
    return [line.start + text.length - text.trimStart().length, line.start + text.trimEnd().length];
  };
  const seen = new Set<string>();
  for (const person of value.n) {
    if (!exactKeys(person, ["n", "k", "e"]) || typeof person.n !== "string" || !person.n.trim() || person.n.length > 100 || ![0, 1].includes(person.k)) { errors.push("invalid name entry"); continue; }
    const evidence = unit(person.e);
    if (evidence && !evidenceNamesPerson(person.n, material.text.slice(...offset(person.e)))) errors.push(`name ${person.n} lacks source evidence`);
    if (seen.has(person.n)) errors.push(`duplicate name ${person.n}`);
    seen.add(person.n);
  }
  const named = (id: unknown): Person | null => {
    if (!Number.isSafeInteger(id) || Number(id) < 0 || Number(id) >= value.n.length) { errors.push(`unknown name index ${id}`); return null; }
    return value.n[Number(id)];
  };
  for (const list of [value.p, value.x]) {
    if (new Set(list).size !== list.length) errors.push("duplicate panel or nonparticipant index");
    for (const id of list) if (named(id)?.k === 1) errors.push("collective author is not a panel judge");
  }
  if (value.p.some((id) => value.x.includes(id))) errors.push("nonparticipant is also participating");
  if ((value.k === 0 && (!value.o.length || value.ev !== null)) || (value.k !== 0 && value.o.length) || (value.k === 2 && value.ev !== null)) errors.push("status and opinions/evidence conflict");
  if (value.k === 1 && !unit(value.ev)) errors.push("reported-only needs source evidence");
  const links = new Map<number, Array<{ opinion_id: string; relation: "wrote" | "joined" | "joined_in_part"; evidence: AnchoredSpan }>>();
  const opinions = value.o.map((opinion, index) => {
    const id = `o${index + 1}`;
    if (!exactKeys(opinion, ["s", "e", "q", "r", "w", "j"]) || !Array.isArray(opinion.w) || !Array.isArray(opinion.j) || opinion.w.length > 40 || opinion.j.length > 40) { errors.push(`invalid opinion ${id}`); return null; }
    const start = unit(opinion.s), end = unit(opinion.e);
    if (!(opinion.q === null || typeof opinion.q === "string" && opinion.q.length > 0 && opinion.q.length <= 300) || !(opinion.r === null || typeof opinion.r === "string" && opinion.r.length > 0 && opinion.r.length <= 300)) errors.push(`invalid partial-unit quote ${id}`);
    let collective_author: { name: string; evidence: AnchoredSpan } | null = null;
    const used = new Set<number>();
    for (const [relation, entries] of [["wrote", opinion.w], ["joined", opinion.j]] as const) {
      for (const entry of entries) {
        if (!exactKeys(entry, relation === "wrote" ? ["i", "e"] : ["i", "e", "r"])) { errors.push(`invalid name link ${id}`); continue; }
        const person = named(entry.i), evidence = unit(entry.e);
        if (used.has(entry.i)) errors.push(`duplicate relationship ${id}/${entry.i}`);
        used.add(entry.i);
        if (!person || !evidence) continue;
        if (person.k === 1) {
          if (relation !== "wrote" || collective_author || opinion.w.length !== 1) errors.push(`invalid collective author ${id}`);
          collective_author = { name: person.n, evidence };
        } else {
          const partial = relation === "joined" && (entry as Join).r === 1;
          if (relation === "joined" && ![0, 1].includes((entry as Join).r)) errors.push(`invalid join qualification ${id}`);
          links.set(entry.i, [...(links.get(entry.i) ?? []), { opinion_id: id, relation: relation === "wrote" ? "wrote" : partial ? "joined_in_part" : "joined", evidence }]);
        }
      }
    }
    return start && end ? { opinion_id: id, boundary: { start_line: opinion.s, end_line: opinion.e, start_quote: opinion.q ?? start.start_quote, end_quote: opinion.r ?? end.end_quote },
      collective_author, result_position: "unclear", result_evidence: null } : null;
  });
  if (errors.length) return fail(errors);
  const participants = [...new Set([...value.p, ...links.keys()])].map((id) => ({ name: value.n[id].n, panel_evidence: unit(value.n[id].e)!, result_position: "unclear", result_evidence: null, opinion_links: links.get(id) ?? [] }));
  const checked = compileStructure({ disposition_spans: [], opinions: value.k === 0 ? opinions : [{ opinion_id: "o1", boundary: unit(value.ev ?? 1), collective_author: null, result_position: "unclear", result_evidence: null }],
    participants, nonparticipants: value.x.map((id) => ({ name: value.n[id].n, evidence: unit(value.n[id].e) })) }, material);
  if (!checked.ok) return fail(checked.errors);
  return { state: value.k === 0 ? 2 : value.k === 1 ? 3 : 4, spans: value.k === 0 ? checked.compiled!.opinions.map(({ boundary }) => [boundary.start, boundary.end]) : [], errors: [], compilation: value.k === 0 ? checked : null,
    names: { names: value.n.map(({ n, k, e }) => ({ name: n, kind: k, evidence: offset(e) })), panel: value.p, nonparticipants: value.x,
      opinions: value.o.map(({ w, j }) => ({ writers: w.map(({ i, e }) => ({ person: i, evidence: offset(e) })), joins: j.map(({ i, e, r }) => ({ person: i, partial: r === 1, evidence: offset(e) })) })) } };
}

/** Bad attribution cannot discard a mechanically valid partition. */
export function compileBoundaryOutput(raw: unknown, material: CaseMaterial) {
  const rich = compileRichOutput(raw, material);
  if (!rich.errors.length) return { ...rich, name_errors: [] as string[] };
  if (exactKeys(raw, ["k", "n", "p", "x", "o", "ev"]) && Array.isArray((raw as Response).o)) {
    const value = raw as Response;
    const boundary = compileRichOutput({ ...value, n: [], p: [], x: [], o: value.o.map((opinion) => ({ ...opinion, w: [], j: [] })) }, material);
    if (!boundary.errors.length) return { ...boundary, names: null, name_errors: rich.errors };
  }
  return { ...rich, name_errors: [] as string[] };
}

/** String dictionary IDs are labels, not an assertion of cross-case person identity. */
export function judicialNameValues(names: JudicialNames, intern: (name: string) => number): number[] {
  const values = [names.names.length];
  for (const person of names.names) values.push(intern(person.name), person.kind, person.evidence[0], person.evidence[1] - person.evidence[0]);
  values.push(names.panel.length, ...names.panel, names.nonparticipants.length, ...names.nonparticipants, names.opinions.length);
  for (const opinion of names.opinions) {
    values.push(opinion.writers.length);
    for (const writer of opinion.writers) values.push(writer.person, writer.evidence[0], writer.evidence[1] - writer.evidence[0]);
    values.push(opinion.joins.length);
    for (const join of opinion.joins) values.push(join.person, join.partial ? 1 : 0, join.evidence[0], join.evidence[1] - join.evidence[0]);
  }
  return values;
}

export function judicialNamesFromValues(values: number[], label: (id: number) => string): JudicialNames {
  let index = 0;
  const take = () => { const value = values[index++]; if (!Number.isSafeInteger(value) || value < 0) throw new Error("truncated judicial names"); return value; };
  const span = (): Span => { const start = take(); return [start, start + take()]; };
  const list = <T>(read: () => T) => Array.from({ length: take() }, read);
  const names = list(() => { const name = label(take()), kind = take() as 0 | 1; return { name, kind, evidence: span() }; });
  const panel = list(take), nonparticipants = list(take);
  const opinions = list(() => ({ writers: list(() => ({ person: take(), evidence: span() })),
    joins: list(() => { const person = take(), partial = Boolean(take()); return { person, partial, evidence: span() }; }) }));
  if (index !== values.length) throw new Error("extra judicial-name values");
  return { names, panel, nonparticipants, opinions };
}
