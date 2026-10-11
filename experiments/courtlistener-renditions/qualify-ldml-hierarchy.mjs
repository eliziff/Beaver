// Qualify actual retained LDML fields; source gold is frozen before native edits.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {zstdCompressSync, zstdDecompressSync} from 'node:zlib';

const root = process.cwd();
const suite = 'benchmarks/local-data/courtlistener-renditions';
const acceptedHome = `${suite}/ldml-opinion-components`;
const home = `${suite}/ldml-heading-hierarchy`;
const guard = 4_406_164_480, growth = 4_194_304, cap = 16_777_216;
const mode = process.argv[2];
if (!['inspect', 'prepare', 'candidate'].includes(mode)) {
  throw Error('Use qualify-ldml-hierarchy.mjs inspect | prepare | candidate CAPTURE_JSON');
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = file => path.relative(root, path.resolve(file)).replaceAll('\\', '/');
const encode = value => Buffer.from(JSON.stringify(value) + '\n');
const normalized = text => text.split(/\p{White_Space}+/u).filter(Boolean).join(' ');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function proof(file) {
  const bytes = fs.readFileSync(file);
  return {path: relative(file), bytes: bytes.length, sha256: sha(bytes)};
}
function bound(input) {
  const bytes = fs.readFileSync(input.path);
  if (bytes.length !== input.bytes || sha(bytes) !== input.sha256) throw Error(`Frozen input changed: ${input.path}`);
  return bytes;
}
const read = input => JSON.parse(bound(input));
function measure(directory) {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, {withFileTypes: true}).reduce((bytes, entry) => {
    const file = path.join(directory, entry.name);
    return bytes + (entry.isDirectory() ? measure(file) : entry.isFile() ? fs.statSync(file).size : 0);
  }, 0);
}
function writerRequired() {
  if (process.env.COURTLISTENER_BUDGET_WRITER !== '1'
    || process.env.COURTLISTENER_REQUIRED_BYTES !== String(guard + growth)) {
    throw Error('Existing budget.writer()/require_bytes() admission must cover every publication');
  }
}
const initialBytes = measure(home);
function publish(name, value) {
  writerRequired();
  const bytes = Buffer.isBuffer(value) ? value : encode(value), current = measure(home);
  if (current - initialBytes + bytes.length > growth || current + bytes.length > cap) throw Error('LDML qualification lease exceeded');
  const file = path.join(home, name);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, bytes, {flag: 'wx'});
  return proof(file);
}
function outputs(run) {
  const records = run.outputs.find(input => input.path.endsWith('/records.jsonl.zst'));
  const summary = run.outputs.find(input => input.path.endsWith('/summary.json'));
  if (!records || !summary) throw Error('Actual corpus output missing');
  return {records, summary};
}
const records = input => zstdDecompressSync(bound(input)).toString('utf8').trimEnd().split('\n').map(JSON.parse);
const scorer = proof(fileURLToPath(import.meta.url));
const qualifies = (element, tag, token) => element[1] === tag && (element[8].class ?? '').split(/[\t\n\f\r ]+/).includes(token);
const heading = element => qualifies(element, 'section', 'ldml-heading');
const section = element => qualifies(element, 'div', 'ldml-section');
function ancestors(graph, element) {
  const result = [];
  for (let parent = element[3]; parent !== null; parent = graph[parent][3]) result.push(graph[parent]);
  return result;
}

// These witnesses contain only literal text and SPAN/B/EM inside the declared heads.
// Refuse another representation instead of turning a renderer into source gold.
function sourceTitle(raw, graph, element) {
  const inner = raw.subarray(element[5], element[6]);
  if (inner.includes(38) || inner.toString('utf8').includes('<!--')) throw Error('Heading source needs separately qualified entity/comment handling');
  const descendants = graph.filter(child => child[4] >= element[5] && child[7] <= element[6]);
  if (descendants.some(child => !['span', 'b', 'em'].includes(child[1]) || !child[9] || child[10])) throw Error('Unqualified heading text representation');
  const tokens = descendants.flatMap(child => [[child[4], child[5]], [child[6], child[7]]]).sort((a, b) => a[0] - b[0]);
  let cursor = element[5], literal = '';
  for (const [start, end] of tokens) {
    if (start < cursor || start === null || end > element[6]) throw Error('Overlapping source heading token');
    literal += raw.subarray(cursor, start).toString('utf8');
    cursor = end;
  }
  literal += raw.subarray(cursor, element[6]).toString('utf8');
  if (literal.includes('<') || literal.includes('>')) throw Error('Unaccounted source heading token');
  return {literal_text: literal, normalized_title: normalized(literal), literal_inner_utf8: {bytes: inner.length, sha256: sha(inner)}};
}
function sourceDeclaration(graph, element) {
  if (!element[9] || element[10]) throw Error('Qualified source role has no exact matching close');
  const chain = ancestors(graph, element), sections = chain.filter(section);
  return {
    role: heading(element) ? 'heading' : 'section', source_index: element[0], raw_tag: element[2],
    source_parent_index: element[3], opening_utf8: {start: element[4], end: element[5]},
    closing_utf8: {start: element[6], end: element[7]}, attributes: element[8],
    qualified_section_ancestor_indexes: sections.map(value => value[0]),
    qualified_section_depth: heading(element) ? sections.length - 1 : sections.length,
    nearest_qualified_section_source_index: sections[0]?.[0] ?? null,
    matched_exact_tag_close: true,
  };
}
function references(value, identity, location = '') {
  if (typeof value === 'string') return value === identity ? [location] : [];
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => references(child, identity, `${location}/${key}`));
}
function preparePlan() {
  const acceptedProof = proof(`${acceptedHome}/candidate-comparison.json`), accepted = read(acceptedProof);
  if (accepted.status !== 'passed' || accepted.diagnostics.length || accepted.counts.exact_complete_candidate_records !== 10) throw Error('Accepted LDML before proof missing');
  const sourceGold = read(accepted.inputs.source_expectations), controlGold = read(accepted.inputs.control_source_expectations);
  const beforeProof = accepted.inputs.candidate_capture, before = read(beforeProof), beforeBuild = read(accepted.candidate_build);
  if (!same(before.executable, accepted.candidate_executable) || !same(before.build, accepted.candidate_build)
    || !before.source_stable || before.failures !== 0 || before.runs.length !== 5
    || !beforeBuild.source_stable || beforeBuild.exit_code !== 0 || !same(beforeBuild.source_before, beforeBuild.source_after)
    || !same(beforeBuild.native, before.executable) || !same(before.build_source_before, beforeBuild.source_after)
    || !same(before.build_source_after, beforeBuild.source_after)) throw Error('Accepted actual native before binding differs');
  bound(before.executable);
  for (const [file, input] of Object.entries(beforeBuild.source_after)) bound({path: file, ...input});
  const previousCorrespondence = read(accepted.inputs.before_comparison);
  if (previousCorrespondence.status !== 'passed' || previousCorrespondence.source_differences.length
    || !same(previousCorrespondence.inputs.source_expectations, accepted.inputs.source_expectations)
    || !same(previousCorrespondence.inputs.control_source_expectations, accepted.inputs.control_source_expectations)) throw Error('Independent source graph correspondence missing');
  const readings = [...sourceGold.readings, ...controlGold.readings], sourceReadings = [], deltas = [], cohorts = [];
  const counts = {records: 0, source_elements: 0, declared_headings: 0, declared_sections: 0, exact_source_closes: 0,
    exact_source_heading_texts: 0, source_heading_ids: 0, replaced_heuristic_headings: 0, unrelated_node_changes: 0,
    css_only_negative_controls: 0, old_outline_entries: 0, expected_outline_entries: 0, expected_identity_adjustments: 0};
  const conversion = previousCorrespondence.source_proven_attribute_conversions;
  for (const run of before.runs) {
    if (run.exit_code !== 0) throw Error('Before corpus failed');
    const output = outputs(run), rows = records(output.records), summary = read(output.summary);
    const manifest = proof(run.argv[2]), captures = bound(manifest).toString('utf8').trimEnd().split('\n').map(JSON.parse);
    if (rows.length !== captures.length || rows.length !== summary.records || summary.errors !== 0) throw Error('Before cohort incomplete');
    const expectedRows = rows.map((record, ordinal) => {
      const key = `${run.cohort}|${ordinal}`, reading = readings.find(value => value.key === key);
      if (!reading || !same(record.source_capture, reading.capture) || !same(record.source_capture, captures[ordinal])) throw Error('Before/source membership differs');
      const original = bound(reading.original);
      const raw = reading.capture.format === 'cap-json' ? Buffer.from(JSON.parse(original).casebody.data) : original;
      if (sha(raw) !== reading.engine_input_markup.sha256 || record.markup_sha256 !== sha(raw)) throw Error('Source markup identity differs');
      const graph = reading.literal_graph.elements, elements = record.markup_elements;
      if (graph.length !== elements.length || !same(record.source_markup, {markup_elements: elements, markup_ancestors: record.markup_ancestors, markup_sha256: record.markup_sha256})) throw Error('Complete SourceMarkup differs');
      for (let index = 0; index < graph.length; index++) {
        const literal = graph[index], element = elements[index], attrs = {...literal[8]};
        for (const change of conversion.filter(value => value.key === key && value.markup_start === literal[4])) {
          if (attrs[change.attribute] !== change.literal_source_value) throw Error('Prior qualified attribute conversion source differs');
          attrs[change.attribute] = change.existing_parsed_graph_value;
        }
        if (literal[0] !== index || literal[2] !== element.tag || literal[3] !== element.parent
          || literal[4] !== element.markup_start || literal[7] !== element.markup_end || !same(attrs, element.attributes)) throw Error(`Complete literal graph correspondence differs: ${key}|${index}`);
      }
      const native = record.native_structures.filter(node => node.source === 'native');
      const owners = new Map(native.map(node => [node.markup_start, node]));
      const declarations = graph.filter(element => heading(element) || section(element)).map(element => {
        if (owners.has(element[4])) throw Error('Native LDML heading/section already projected');
        const declaration = sourceDeclaration(graph, element);
        if (heading(element)) {
          if (declaration.qualified_section_depth < 0) throw Error('Heading has no qualified LDML Section ancestry');
          Object.assign(declaration, sourceTitle(raw, graph, element));
          if (normalized(record.text.slice(elements[element[0]].range.start, elements[element[0]].range.end)) !== declaration.normalized_title) throw Error('Independent heading text and frozen rendered observation differ');
          if (!declaration.normalized_title || [...declaration.normalized_title].length > 200) throw Error('Heading requires independently prescribed outline filtering');
          const cssDepths = (element[8].class ?? '').split(/[\t\n\f\r ]+/)
            .flatMap(value => /^content__heading--depth([1-9]\d*)$/.exec(value)?.slice(1).map(Number) ?? []);
          declaration.observed_css_depths = cssDepths;
          declaration.css_depth_agrees_with_physical_source_ancestry = cssDepths.every(value => value === declaration.qualified_section_depth + 1);
          if (!declaration.css_depth_agrees_with_physical_source_ancestry) throw Error('Selected witness physical/CSS depth observation differs');
          counts.declared_headings++; counts.exact_source_heading_texts++;
          if (element[8].id) counts.source_heading_ids++;
        } else counts.declared_sections++;
        counts.exact_source_closes++;
        return declaration;
      });
      const negatives = graph.filter(element => (element[8].class ?? '').split(/[\t\n\f\r ]+/).includes('content__heading')
        && !heading(element) && !['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'heading', 'h'].includes(element[1]))
        .map(element => ({source_index: element[0], tag: element[2], markup_start: element[4], attributes: element[8],
          expected_additional_heading_roles: 0}));
      if (negatives.some(value => native.some(node => node.markup_start === value.markup_start && node.kind === 'heading'))) throw Error('CSS-only negative has an existing heading role');
      counts.css_only_negative_controls += negatives.length;
      const additions = [];
      for (const declaration of declarations) {
        const element = elements[declaration.source_index];
        let parentNode;
        for (const ancestor of ancestors(graph, graph[declaration.source_index])) {
          const node = owners.get(ancestor[4]);
          if (node && node.kind !== 'page' && node.range.start <= element.range.start && node.range.end >= element.range.end) { parentNode = node; break; }
        }
        const anchor = element.attributes.id;
        const node = {id: `native-markup-${element.markup_start}`, kind: declaration.role, range: element.range,
          origin_id: 'provider-adapter', source: 'native', ...(anchor ? {label: anchor} : {}),
          ...(parentNode ? {parent_id: parentNode.id} : {}), ...(anchor ? {anchor} : {}), markup_tag: element.tag.toLowerCase(),
          markup_start: element.markup_start, markup_attributes: element.attributes};
        additions.push(node); owners.set(element.markup_start, node);
      }
      const replacements = record.native_structures.filter(node => node.source === 'heuristic' && node.kind === 'heading')
        .flatMap(node => {
          const declaration = declarations.find(value => value.role === 'heading' && same(elements[value.source_index].range, node.rendered_range ?? node.range));
          if (!declaration) return [];
          if (normalized(node.label ?? '') !== declaration.normalized_title) throw Error('Source heading would lose existing heuristic content');
          const outsideReferences = Object.entries(record).filter(([key]) => key !== 'native_structures')
            .flatMap(([key, value]) => references(value, node.id, `/${key}`));
          if (outsideReferences.length || record.native_structures.some(child => child.parent_id === node.id)) throw Error('Replaced heading has an independently unresolved identity reference');
          return [{old_node: node, source_index: declaration.source_index, replacement_id: `native-markup-${declaration.opening_utf8.start}`,
            exact_content_and_range: true, outside_identity_references: outsideReferences}];
        });
      const removedIds = new Set(replacements.map(value => value.old_node.id));
      counts.replaced_heuristic_headings += replacements.length;
      const headingEntries = declarations.filter(value => value.role === 'heading').map(value => ({kind: 'heading',
        level: value.qualified_section_depth, title: value.normalized_title, start: elements[value.source_index].range.start}));
      const replacedStarts = new Set(replacements.map(value => (value.old_node.rendered_range ?? value.old_node.range).start));
      const outline = [...record.document_outline.filter(entry => !replacedStarts.has(entry.start)), ...headingEntries].sort((a, b) => a.start - b.start);
      const titleCounts = new Map();
      for (const entry of outline.filter(value => value.kind === 'heading')) titleCounts.set(entry.title.toLowerCase(), (titleCounts.get(entry.title.toLowerCase()) ?? 0) + 1);
      if ([...titleCounts.values()].some(count => count >= 3)) throw Error('Running-head suppression needs a separately enumerated outline contract');
      counts.old_outline_entries += record.document_outline.length; counts.expected_outline_entries += outline.length;
      let projected = record.native_structures;
      if (additions.length) {
        const oldDeclared = native.filter(node => (node.markup_tag === 'div' && (node.markup_attributes?.class ?? '').split(/[\t\n\f\r ]+/).includes('ldml-opinion'))
          || (node.markup_tag === 'span' && (node.markup_attributes?.class ?? '').split(/[\t\n\f\r ]+/).includes('ldml-appendix')));
        if (!oldDeclared.length || !same(native.slice(-oldDeclared.length), oldDeclared)) throw Error('Existing post-render declaration order differs');
        projected = [...native.slice(0, -oldDeclared.length), ...[...oldDeclared, ...additions].sort((a, b) => a.markup_start - b.markup_start),
          ...record.native_structures.filter(node => node.source !== 'native' && !removedIds.has(node.id))];
      }
      const expected = {...record, native_structures: projected, document_outline: outline};
      const expectedOld = projected.filter(node => !additions.some(value => value.id === node.id));
      if (!same(expectedOld, record.native_structures.filter(node => !removedIds.has(node.id)))) throw Error('An unrelated node would change');
      sourceReadings.push({key, original: reading.original, engine_input_markup: reading.engine_input_markup,
        independent_literal_graph_owner: reading.cohort === 'dl2' ? accepted.inputs.control_source_expectations : accepted.inputs.source_expectations,
        source_graph_elements: graph.length, declarations, css_only_negative_controls: negatives,
        coordinate_contract: 'Roles, hierarchy, lexical extents and titles come from independent original source; UTF16 ranges are frozen existing-producer observations'});
      deltas.push({key, additional_native_nodes: additions, source_backed_heuristic_replacements: replacements,
        css_only_before_observations: negatives.map(value => ({...value, native_roles: native.filter(node => node.markup_start === value.markup_start)})),
        remaining_identity_adjustments: [], before_outline: record.document_outline, exact_expected_outline: outline,
        outline_contract: 'Only exact source-declared heading roles; zero-based level is actual qualified LDML Section ancestry minus its own containing section. CSS depth, H@level and opinion/appendix Sections supply no rank. Existing native declarations, unrelated heuristics, body/front-matter filtering and running-head suppression remain unchanged.'});
      counts.records++; counts.source_elements += graph.length;
      return expected;
    });
    const expectedRaw = Buffer.from(expectedRows.map(value => JSON.stringify(value)).join('\n') + '\n');
    cohorts.push({cohort: run.cohort, count: rows.length, manifest, corpus_home: run.argv[3], before: output, before_argv: run.argv,
      prospective_candidate_argv: [...run.argv.slice(0, 4), `${home}/native-candidate/${run.cohort}`], before_summary: summary,
      allowed_summary_changes: ['seconds', 'engine_source_sha256'], expected_raw: expectedRaw,
      expected_raw_records: {bytes: expectedRaw.length, sha256: sha(expectedRaw)}});
  }
  if (counts.records !== 10 || counts.source_elements !== 9_986 || counts.declared_headings !== 50
    || counts.declared_sections !== 50 || counts.replaced_heuristic_headings !== 12 || counts.source_heading_ids !== 50) throw Error('Selected LDML source qualification membership differs');
  return {inputs: {accepted_comparison: acceptedProof, independent_source_graph: accepted.inputs.source_expectations,
    independent_control_graph: accepted.inputs.control_source_expectations, qualified_source_attribute_correspondence: accepted.inputs.before_comparison,
    before_provenance: beforeProof, before_build: accepted.candidate_build, scorer}, historical_before_executable: before.executable,
    unchanged_before_sources: beforeBuild.source_after, counts, sourceReadings, deltas, cohorts};
}

if (mode === 'inspect' || mode === 'prepare') {
  const plan = preparePlan();
  const compact = {counts: plan.counts, cohorts: plan.cohorts.map(value => ({cohort: value.cohort, count: value.count,
    before_records: value.before.records, expected_raw_records: value.expected_raw_records})),
    replacements: plan.deltas.filter(value => value.source_backed_heuristic_replacements.length).map(value => ({key: value.key,
      replaced_claims: value.source_backed_heuristic_replacements.map(item => ({id: item.old_node.id, range: item.old_node.range,
        source_index: item.source_index, replacement_id: item.replacement_id, exact_content_and_range: item.exact_content_and_range}))}))};
  if (mode === 'inspect') console.log(JSON.stringify({...compact, persistence: false, native_runs: 0, tests_written_or_run: 0}));
  else {
    if (initialBytes !== 0) throw Error('New frozen owner must be empty');
    const allocation = publish('allocation.json', {schema: 'courtlistener.ldml-heading-bounded-allocation.v1', total_maximum_bytes: cap,
      publication_growth_maximum_bytes: growth, physical_guard_bytes: guard, source_location: acceptedHome, tests_written_or_run: 0});
    const gold = publish('source-expectations.json', {schema: 'courtlistener.ldml-heading-independent-source.v1', source_only: true,
      frozen_utc: new Date().toISOString(), inputs: {independent_source_graph: plan.inputs.independent_source_graph,
        independent_control_graph: plan.inputs.independent_control_graph, scorer},
      counts: {records: plan.counts.records, source_elements: plan.counts.source_elements, declared_headings: plan.counts.declared_headings,
        declared_sections: plan.counts.declared_sections, exact_source_closes: plan.counts.exact_source_closes,
        source_heading_ids: plan.counts.source_heading_ids, css_only_negative_controls: plan.counts.css_only_negative_controls}, readings: plan.sourceReadings,
      interpretation: 'Source heading/section role declarations and exact physical ancestry only; titles/IDs retain literal source evidence, never judicial-reasons semantics',
      native_runs: 0, tests_written_or_run: 0, downloads: 0});
    const expectedCohorts = plan.cohorts.map(({expected_raw, ...cohort}) => ({...cohort,
      expected_candidate_records: publish(`expected-candidate/${cohort.cohort}/records.jsonl.zst`, zstdCompressSync(expected_raw))}));
    const contract = publish('candidate-contract.json', {schema: 'courtlistener.ldml-heading-complete-record-contract.v1',
      status: 'frozen-before-rust-edits', frozen_utc: new Date().toISOString(), allocation, source_expectations: gold,
      ...plan.inputs, historical_before_executable: plan.historical_before_executable, unchanged_before_sources: plan.unchanged_before_sources,
      counts: plan.counts, expected_cohorts: expectedCohorts, exact_source_supported_deltas: plan.deltas,
      only_record_changes: ['Add fifty Native Section and fifty Native Heading projections with actual source ancestry and IDs',
        'Replace twelve exactly matching heuristic headings with their source declarations',
        'Add fifty exact declared headings to the outline and remove twelve replaced heuristic entries; levels follow qualified Section ancestry'],
      exact_preservation: 'Every unrelated complete-record value, source graph, text, existing node capability/range/parent, note, source opinion/type/author query, anchor/name lookup, page/footnote query and control is exact',
      limits: ['Ten selected real fields are a qualification sample, not universal LDML correctness',
        'Rendered UTF16 range correctness is not independent gold; its existing observed values must stay exact',
        'These original headings need no entity/comment/hidden-text interpretation; other shapes require separate source qualification',
        'No publisher browser landing or reasons-heading semantic proof'], tests_written_or_run: 0, native_runs_by_preparer: 0});
    publish('README.md', Buffer.from(`# LDML heading hierarchy qualification

The retained original sources and accepted full records live once in
\`${acceptedHome}\` and its existing control owners. This owner binds them by
SHA-256 and freezes source gold and ten complete expected records before Rust edits.

Fifty \`section.ldml-heading\` and fifty \`div.ldml-section\` declarations have
exact matched source closes. Titles come from literal original text between
independent source tokens; these heads contain only SPAN/B/EM and no entities,
comments or hidden content. Physical LDML Section ancestry supplies outline
levels 0/1/2. CSS depths are recorded as corroborating observations, never rank
authority. Broad heading CSS on eighteen other declarations adds no heading role.
Neither a source heading declaration nor an existing ID proves reasons semantics
or a successful publisher browser landing.

The complete contract adds one hundred Native nodes, replaces twelve heuristic
heading claims with exactly matching source headings and changes the outline
from twenty-four to sixty-two entries. All unrelated record values stay exact.
Every replacement and its source owner is individually listed; remaining identity
adjustments are empty. Before UTF16 ranges are producer observations, separate
from independent source role/text/ancestry gold.

Read-only regeneration: \`node experiments/courtlistener-renditions/qualify-ldml-hierarchy.mjs inspect\`.
Frozen publication: the same command with \`prepare\`, under existing
\`budget.writer()/require_bytes(${guard + growth})\` admission and the existing
writer environment contract. It never bypasses another writer, runs Native,
builds, downloads or writes/runs tests. The owner cap is sixteen MiB with four
MiB growth per admitted publication. Existing frozen outputs are never overwritten.

The root runs the five exact \`prospective_candidate_argv\` commands in
\`candidate-contract.json\` and binds stable build/source/executable provenance.
Under the same writer admission, \`candidate CAPTURE_JSON\` compares those
complete actual records with the unchanged frozen contract. The scorer never
regenerates gold from candidate output.
`));
    console.log(JSON.stringify({...compact, source_expectations: gold, contract, owner_bytes: measure(home), native_runs: 0, tests_written_or_run: 0}));
  }
} else {
  if (!process.argv[3]) throw Error('Actual candidate capture required');
  const contractProof = proof(`${home}/candidate-contract.json`), contract = read(contractProof);
  if (!same(contract.scorer, scorer) || contract.status !== 'frozen-before-rust-edits') throw Error('Frozen corpus contract/scorer differs');
  for (const key of ['allocation', 'source_expectations', 'accepted_comparison', 'independent_source_graph', 'independent_control_graph',
    'qualified_source_attribute_correspondence', 'before_provenance', 'before_build']) bound(contract[key]);
  const captureProof = proof(process.argv[3]), capture = read(captureProof), build = read(capture.build);
  if (!same(capture.candidate_contract, contractProof) || !same(capture.source_expectations, contract.source_expectations)
    || !capture.source_stable || capture.failures !== 0 || capture.runs.length !== 5 || !build.source_stable
    || build.exit_code !== 0 || !same(build.source_before, build.source_after) || !same(capture.executable, build.native)
    || !same(capture.build_source_before, build.source_after) || !same(capture.build_source_after, build.source_after)) throw Error('Candidate actual build/capture identity differs');
  bound(capture.executable);
  for (const [file, input] of Object.entries(build.source_after)) bound({path: file, ...input});
  const diagnostics = [], counts = {exact_complete_records: 0, exact_source_graphs: 0, exact_outlines: 0,
    exact_source_opinion_queries: 0, additional_native_headings: 0, additional_native_sections: 0, replaced_heuristic_headings: 0};
  for (const cohort of contract.expected_cohorts) {
    const run = capture.runs.find(value => value.cohort === cohort.cohort);
    if (!run || run.exit_code !== 0 || !same(run.argv, cohort.prospective_candidate_argv)) throw Error('Actual candidate command/source differs');
    bound(cohort.manifest);
    const output = outputs(run), actual = records(output.records), expected = records(cohort.expected_candidate_records), before = records(cohort.before.records);
    const expectedRaw = zstdDecompressSync(bound(cohort.expected_candidate_records));
    if (expectedRaw.length !== cohort.expected_raw_records.bytes || sha(expectedRaw) !== cohort.expected_raw_records.sha256
      || actual.length !== cohort.count || expected.length !== cohort.count || before.length !== cohort.count) throw Error('Candidate complete-record membership differs');
    for (let ordinal = 0; ordinal < actual.length; ordinal++) {
      const value = actual[ordinal], wanted = expected[ordinal], previous = before[ordinal], key = `${cohort.cohort}|${ordinal}`;
      if (same(value, wanted)) counts.exact_complete_records++;
      else diagnostics.push({key, kind: 'complete-record-values-differ', fields: [...new Set([...Object.keys(value), ...Object.keys(wanted)])].filter(field => !same(value[field], wanted[field])),
        expected_sha256: sha(encode(canonical(wanted))), actual_sha256: sha(encode(canonical(value)))});
      for (const [field, count] of [['source_markup', 'exact_source_graphs'], ['document_outline', 'exact_outlines'], ['source_opinion_components', 'exact_source_opinion_queries']]) {
        if (same(value[field], wanted[field])) counts[count]++; else diagnostics.push({key, kind: `${field}-differs`});
      }
      for (const [kind, count] of [['heading', 'additional_native_headings'], ['section', 'additional_native_sections']]) {
        counts[count] += value.native_structures.filter(node => node.source === 'native' && node.kind === kind).length
          - previous.native_structures.filter(node => node.source === 'native' && node.kind === kind).length;
      }
      counts.replaced_heuristic_headings += previous.native_structures.filter(node => node.source === 'heuristic' && node.kind === 'heading').length
        - value.native_structures.filter(node => node.source === 'heuristic' && node.kind === 'heading').length;
    }
    const summary = read(output.summary), oldSummary = {...cohort.before_summary}, candidateSummary = {...summary};
    for (const key of cohort.allowed_summary_changes) { delete oldSummary[key]; delete candidateSummary[key]; }
    if (!same(oldSummary, candidateSummary)) diagnostics.push({cohort: cohort.cohort, kind: 'summary-values-differ', expected: oldSummary, actual: candidateSummary});
  }
  if (counts.exact_complete_records !== 10 || counts.additional_native_headings !== 50 || counts.additional_native_sections !== 50
    || counts.replaced_heuristic_headings !== 12) diagnostics.push({kind: 'candidate-counts-differ', counts});
  const comparison = publish(diagnostics.length ? 'candidate-comparison.failed.json' : 'candidate-comparison.json', {
    schema: 'courtlistener.ldml-heading-candidate-comparison.v1', status: diagnostics.length ? 'failed' : 'passed', completed_utc: new Date().toISOString(),
    source_expectations: contract.source_expectations, candidate_contract: contractProof, candidate_capture: captureProof,
    historical_before_executable: contract.historical_before_executable, candidate_executable: capture.executable, candidate_build: capture.build,
    scorer, counts, diagnostics, performance_claimed: false, tests_written_or_run: 0, native_runs_by_scorer: 0});
  console.log(JSON.stringify({status: diagnostics.length ? 'failed' : 'passed', comparison, counts, diagnostics, owner_bytes: measure(home)}));
  if (diagnostics.length) process.exitCode = 1;
}
