export type DatePrecision = "day" | "month" | "year";

export type PartialDate = { value: string; precision: DatePrecision };

export type PersonRecord = {
  id: string;
  canonicalName: string;
  /** Source spellings, retained apart from surrounding whitespace. */
  aliases: string[];
};

export type RegistrySource = {
  id: string;
  url: string;
  retrievedAt: string;
  sha256: string;
};

export type CourtRecord = {
  id: string;
  canonicalName: string;
  aliases: string[];
  datasetAliases: string[];
};

export type AssignmentType =
  | "permanent"
  | "supernumerary"
  | "acting"
  | "deputy"
  | "ad_hoc"
  | "ex_officio"
  | "other";

export type ClaimEvidence = {
  sourceId: string;
  /** Exact compact source text supporting this claim. */
  sourceQuote: string;
};

/** Minimal CourtListener-style Person -> Position -> Court link. */
export type PositionRecord = {
  id: string;
  personId: string;
  courtId: string;
  dateStart: PartialDate | null;
  dateTermination: PartialDate | null;
  /** Stable normalized role key and part of this position's logical identity. */
  positionType: string;
  /** Human-readable title as published by the source. */
  role: string;
  assignmentType: AssignmentType;
  evidence: ClaimEvidence[];
};

/** A current/name-only page proves membership only at this point in time. */
export type RosterObservation = {
  id: string;
  personId: string;
  courtId: string;
  observedOn: string;
  positionType: string;
  role: string;
  evidence: ClaimEvidence[];
};

export type JudgeCourtRegistryData = {
  version: 1;
  generatedAt: string;
  sources: RegistrySource[];
  people: PersonRecord[];
  courts: CourtRecord[];
  positions: PositionRecord[];
  rosterObservations: RosterObservation[];
};

export type JudgeCourtQuery = {
  displayedName: string;
  court?: string;
  dataset?: string;
  decisionDate: string;
};

type CourtMatch = {
  court: CourtRecord;
  matchedCourtBy: Array<"court" | "dataset">;
};

export type RegistryMatchEvidence = CourtMatch & (
  | { kind: "position"; position: PositionRecord; temporalMatch: "certain" | "possible" }
  | { kind: "roster_observation"; observation: RosterObservation; temporalMatch: "certain" }
);

export type JudgeCourtCandidate = {
  person: PersonRecord;
  /** Raw registry spellings that matched the raw displayed name. */
  matchedNames: string[];
  evidence: RegistryMatchEvidence[];
};

export type JudgeCourtResolution = {
  status: "unique" | "ambiguous" | "no_match";
  /** Echoed without normalization so unresolved case strings are never lost. */
  displayedName: string;
  candidates: JudgeCourtCandidate[];
  nameMatches: PersonRecord[];
  courtMatches: CourtRecord[];
  /** A no-match is absence of registry support, never proof the person could not sit. */
  noMatchMayBeUnrecordedAssignment: boolean;
};

export type CourtRosterQuery = Omit<JudgeCourtQuery, "displayedName">;

export type CourtRosterResolution = {
  status: "unique_court" | "ambiguous_court" | "no_court";
  courtMatches: CourtRecord[];
  candidates: Array<{ person: PersonRecord; evidence: RegistryMatchEvidence[] }>;
};

export type JudgeCourtServiceResolver = ((query: JudgeCourtQuery) => JudgeCourtResolution) & {
  serving(query: CourtRosterQuery): CourtRosterResolution;
};

type DateBounds = { earliest: string; latest: string };

function normalizeKey(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-CA")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function exactString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function isoDateTime(value: unknown, label: string) {
  const result = requiredString(value, label);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(result) ||
    Number.isNaN(Date.parse(result))
  ) throw new Error(`${label} must be an ISO date-time`);
  return result;
}

export function normalizeJudgeName(value: string) {
  return normalizeKey(value)
    .replace(/^(?:the )?honou?rable /u, "")
    .replace(/^(?:(?:mr|mrs|madam|madame) )?(?:chief justice|justice|judge) /u, "")
    .replace(/ (?:a c j|c j a|c j|j j a|j a|j j|j c|j)$/u, "")
    .trim();
}

function indexByAlias<T>(
  records: T[],
  aliases: (record: T) => string[],
  normalize: (value: string) => string = normalizeKey,
) {
  const index = new Map<string, T[]>();
  for (const record of records) {
    for (const alias of aliases(record)) {
      const key = normalize(alias);
      if (!key) continue;
      const matches = index.get(key) ?? [];
      if (!matches.includes(record)) matches.push(record);
      index.set(key, matches);
    }
  }
  return index;
}

function validDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value;
}

function dateBounds(date: PartialDate): DateBounds {
  if (date.precision === "day") {
    if (!validDay(date.value)) throw new Error(`Invalid position day: ${date.value}`);
    return { earliest: date.value, latest: date.value };
  }
  if (date.precision === "month") {
    const match = /^(\d{4})-(\d{2})$/u.exec(date.value);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12) {
      throw new Error(`Invalid position month: ${date.value}`);
    }
    const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0))
      .getUTCDate().toString().padStart(2, "0");
    return { earliest: `${date.value}-01`, latest: `${date.value}-${lastDay}` };
  }
  if (!/^\d{4}$/u.test(date.value)) throw new Error(`Invalid position year: ${date.value}`);
  return { earliest: `${date.value}-01-01`, latest: `${date.value}-12-31` };
}

function partialDate(value: unknown, label: string): PartialDate | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error(`${label} must be an object or null`);
  const precision = requiredString(value.precision, `${label}.precision`) as DatePrecision;
  if (!(["day", "month", "year"] as const).includes(precision)) {
    throw new Error(`${label}.precision is invalid`);
  }
  const result = { value: requiredString(value.value, `${label}.value`), precision };
  dateBounds(result);
  return result;
}

function uniqueIds<T extends { id: string }>(records: T[], label: string) {
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) throw new Error(`duplicate ${label} id: ${record.id}`);
    seen.add(record.id);
  }
}

function evidenceArray(value: unknown, label: string): ClaimEvidence[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a non-empty array`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`${label}[${index}] must be an object`);
    return {
      sourceId: requiredString(item.sourceId, `${label}[${index}].sourceId`),
      sourceQuote: exactString(item.sourceQuote, `${label}[${index}].sourceQuote`),
    };
  });
}

function roleKey(value: unknown, label: string) {
  const result = requiredString(value, label);
  if (!/^[a-z0-9]+(?:_[a-z0-9]+)*$/u.test(result)) {
    throw new Error(`${label} must be a lowercase snake-case key`);
  }
  return result;
}

/** Validate the complete on-disk snapshot before any decision is loaded. */
export function validateJudgeCourtRegistryData(value: unknown): JudgeCourtRegistryData {
  if (!isRecord(value)) throw new Error("judge/court registry must be an object");
  if (value.version !== 1) throw new Error("judge/court registry version must be 1");
  const generatedAt = isoDateTime(value.generatedAt, "generatedAt");
  if (
    !Array.isArray(value.sources) || !Array.isArray(value.people) || !Array.isArray(value.courts) ||
    !Array.isArray(value.positions) || !Array.isArray(value.rosterObservations)
  ) throw new Error("sources, people, courts, positions, and rosterObservations must be arrays");

  const sources = value.sources.map((raw, index): RegistrySource => {
    if (!isRecord(raw)) throw new Error(`sources[${index}] must be an object`);
    const url = requiredString(raw.url, `sources[${index}].url`);
    let parsedUrl: URL;
    try { parsedUrl = new URL(url); } catch { throw new Error(`sources[${index}].url must be an absolute URL`); }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new Error(`sources[${index}].url must use HTTP or HTTPS`);
    }
    const sha256 = requiredString(raw.sha256, `sources[${index}].sha256`);
    if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`sources[${index}].sha256 must be lowercase SHA-256`);
    return {
      id: requiredString(raw.id, `sources[${index}].id`),
      url,
      retrievedAt: isoDateTime(raw.retrievedAt, `sources[${index}].retrievedAt`),
      sha256,
    };
  });
  const people = value.people.map((raw, index): PersonRecord => {
    if (!isRecord(raw)) throw new Error(`people[${index}] must be an object`);
    return {
      id: requiredString(raw.id, `people[${index}].id`),
      canonicalName: requiredString(raw.canonicalName, `people[${index}].canonicalName`),
      aliases: stringArray(raw.aliases, `people[${index}].aliases`),
    };
  });
  const courts = value.courts.map((raw, index): CourtRecord => {
    if (!isRecord(raw)) throw new Error(`courts[${index}] must be an object`);
    return {
      id: requiredString(raw.id, `courts[${index}].id`),
      canonicalName: requiredString(raw.canonicalName, `courts[${index}].canonicalName`),
      aliases: stringArray(raw.aliases, `courts[${index}].aliases`),
      datasetAliases: stringArray(raw.datasetAliases, `courts[${index}].datasetAliases`),
    };
  });
  const assignmentTypes: AssignmentType[] = [
    "permanent", "supernumerary", "acting", "deputy", "ad_hoc", "ex_officio", "other",
  ];
  const positions = value.positions.map((raw, index): PositionRecord => {
    if (!isRecord(raw)) throw new Error(`positions[${index}] must be an object`);
    const assignmentType = requiredString(raw.assignmentType, `positions[${index}].assignmentType`) as AssignmentType;
    if (!assignmentTypes.includes(assignmentType)) throw new Error(`positions[${index}].assignmentType is invalid`);
    return {
      id: requiredString(raw.id, `positions[${index}].id`),
      personId: requiredString(raw.personId, `positions[${index}].personId`),
      courtId: requiredString(raw.courtId, `positions[${index}].courtId`),
      dateStart: partialDate(raw.dateStart, `positions[${index}].dateStart`),
      dateTermination: partialDate(raw.dateTermination, `positions[${index}].dateTermination`),
      positionType: roleKey(raw.positionType, `positions[${index}].positionType`),
      role: requiredString(raw.role, `positions[${index}].role`),
      assignmentType,
      evidence: evidenceArray(raw.evidence, `positions[${index}].evidence`),
    };
  });
  const rosterObservations = value.rosterObservations.map((raw, index): RosterObservation => {
    if (!isRecord(raw)) throw new Error(`rosterObservations[${index}] must be an object`);
    const observedOn = requiredString(raw.observedOn, `rosterObservations[${index}].observedOn`);
    if (!validDay(observedOn)) throw new Error(`rosterObservations[${index}].observedOn must be a calendar day`);
    return {
      id: requiredString(raw.id, `rosterObservations[${index}].id`),
      personId: requiredString(raw.personId, `rosterObservations[${index}].personId`),
      courtId: requiredString(raw.courtId, `rosterObservations[${index}].courtId`),
      observedOn,
      positionType: roleKey(raw.positionType, `rosterObservations[${index}].positionType`),
      role: requiredString(raw.role, `rosterObservations[${index}].role`),
      evidence: evidenceArray(raw.evidence, `rosterObservations[${index}].evidence`),
    };
  });

  uniqueIds(sources, "source");
  uniqueIds(people, "person");
  uniqueIds(courts, "court");
  uniqueIds(positions, "position");
  uniqueIds(rosterObservations, "roster observation");
  const sourceIds = new Set(sources.map((source) => source.id));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const personIds = new Set(people.map((person) => person.id));
  const courtIds = new Set(courts.map((court) => court.id));
  const validateLinks = (record: PositionRecord | RosterObservation) => {
    if (!personIds.has(record.personId)) throw new Error(`${record.id} references missing person ${record.personId}`);
    if (!courtIds.has(record.courtId)) throw new Error(`${record.id} references missing court ${record.courtId}`);
    for (const claim of record.evidence) {
      if (!sourceIds.has(claim.sourceId)) throw new Error(`${record.id} references missing source ${claim.sourceId}`);
    }
  };
  const logicalPositions = new Set<string>();
  for (const position of positions) {
    validateLinks(position);
    if (!position.dateStart && !position.dateTermination) {
      throw new Error(`${position.id} has no temporal bound; use a roster observation`);
    }
    if (
      position.dateStart && position.dateTermination &&
      dateBounds(position.dateStart).earliest > dateBounds(position.dateTermination).latest
    ) throw new Error(`${position.id} starts after it ends`);
    const logicalIdentity = JSON.stringify([
      position.personId, position.courtId, position.positionType, normalizeKey(position.role),
      position.assignmentType, position.dateStart, position.dateTermination,
    ]);
    if (logicalPositions.has(logicalIdentity)) throw new Error(`duplicate logical position: ${position.id}`);
    logicalPositions.add(logicalIdentity);
  }
  for (const observation of rosterObservations) {
    validateLinks(observation);
    if (!observation.evidence.some(
      (claim) => sourcesById.get(claim.sourceId)?.retrievedAt.slice(0, 10) === observation.observedOn,
    )) throw new Error(`${observation.id} lacks evidence retrieved on its observation day`);
  }
  return { version: 1, generatedAt, sources, people, courts, positions, rosterObservations };
}

function temporalMatch(position: PositionRecord, decisionDate: string): "certain" | "possible" | null {
  const start = position.dateStart ? dateBounds(position.dateStart) : null;
  const end = position.dateTermination ? dateBounds(position.dateTermination) : null;
  if ((start && decisionDate < start.earliest) || (end && decisionDate > end.latest)) return null;
  return ((Boolean(start) && decisionDate >= start!.latest) && (!end || decisionDate <= end.earliest))
    ? "certain"
    : "possible";
}

function compatibleName(displayed: string, candidate: string) {
  const wanted = normalizeJudgeName(displayed).split(" ").filter(Boolean);
  const available = normalizeJudgeName(candidate).split(" ").filter(Boolean);
  if (!wanted.length || !available.length) return false;
  if (wanted.join(" ") === available.join(" ")) return true;
  if (wanted.length === 1) return wanted[0].length >= 2 && wanted[0] === available.at(-1);
  if (wanted.length <= available.length && wanted.every(
    (token, index) => token === available[available.length - wanted.length + index],
  )) return true;
  return wanted.length === 2 && wanted[0].length === 1 && wanted[0] === available[0]?.[0] && wanted[1] === available.at(-1);
}

export function createJudgeCourtServiceResolver(rawData: JudgeCourtRegistryData): JudgeCourtServiceResolver {
  const data = validateJudgeCourtRegistryData(rawData);
  const names = (person: PersonRecord) => [person.canonicalName, ...person.aliases];
  const peopleByName = indexByAlias(data.people, names, normalizeJudgeName);
  const courtsByName = indexByAlias(data.courts, (court) => [court.canonicalName, ...court.aliases]);
  const courtsByDataset = indexByAlias(data.courts, (court) => court.datasetAliases);
  const positionsByPerson = Map.groupBy(data.positions, (position) => position.personId);
  const observationsByPerson = Map.groupBy(data.rosterObservations, (observation) => observation.personId);
  const courtsById = new Map(data.courts.map((court) => [court.id, court]));

  const matchedCourts = (query: CourtRosterQuery) => {
    const courtNameMatches = query.court ? courtsByName.get(normalizeKey(query.court)) ?? [] : [];
    const datasetMatches = query.dataset ? courtsByDataset.get(normalizeKey(query.dataset)) ?? [] : [];
    return { courtNameMatches, datasetMatches, courtMatches: [...new Set([...courtNameMatches, ...datasetMatches])] };
  };
  const validateQuery = (query: CourtRosterQuery) => {
    if (!validDay(query.decisionDate)) throw new Error(`Invalid decision date: ${query.decisionDate}`);
    if (!query.court?.trim() && !query.dataset?.trim()) throw new Error("court or dataset is required");
  };
  const evidenceFor = (
    person: PersonRecord,
    query: CourtRosterQuery,
    courtNameMatches: CourtRecord[],
    datasetMatches: CourtRecord[],
    courtMatches: CourtRecord[],
  ) => {
    const courtIds = new Set(courtMatches.map((court) => court.id));
    const matchCourt = (courtId: string): CourtMatch | null => {
      if (!courtIds.has(courtId)) return null;
      const court = courtsById.get(courtId);
      if (!court) return null;
      const matchedCourtBy: Array<"court" | "dataset"> = [];
      if (courtNameMatches.includes(court)) matchedCourtBy.push("court");
      if (datasetMatches.includes(court)) matchedCourtBy.push("dataset");
      return { court, matchedCourtBy };
    };
    const positions = (positionsByPerson.get(person.id) ?? []).flatMap((position): RegistryMatchEvidence[] => {
      const courtMatch = matchCourt(position.courtId);
      const time = temporalMatch(position, query.decisionDate);
      return courtMatch && time ? [{ ...courtMatch, kind: "position", position, temporalMatch: time }] : [];
    });
    const observations = (observationsByPerson.get(person.id) ?? []).flatMap((observation): RegistryMatchEvidence[] => {
      const courtMatch = matchCourt(observation.courtId);
      return courtMatch && observation.observedOn === query.decisionDate
        ? [{ ...courtMatch, kind: "roster_observation", observation, temporalMatch: "certain" }]
        : [];
    });
    return [...positions, ...observations];
  };

  const serving = (query: CourtRosterQuery): CourtRosterResolution => {
    validateQuery(query);
    const { courtNameMatches, datasetMatches, courtMatches } = matchedCourts(query);
    const candidates = data.people.flatMap((person) => {
      const evidence = evidenceFor(person, query, courtNameMatches, datasetMatches, courtMatches);
      return evidence.length ? [{ person, evidence }] : [];
    });
    return {
      status: courtMatches.length === 1 ? "unique_court" : courtMatches.length > 1 ? "ambiguous_court" : "no_court",
      courtMatches,
      candidates,
    };
  };

  const resolve = ((query: JudgeCourtQuery): JudgeCourtResolution => {
    validateQuery(query);
    if (!query.displayedName.trim()) throw new Error("displayedName must be a non-empty string");
    const nameKey = normalizeJudgeName(query.displayedName);
    const exactNameMatches = peopleByName.get(nameKey) ?? [];
    const nameMatches = exactNameMatches.length
      ? exactNameMatches
      : data.people.filter((person) => names(person).some((name) => compatibleName(query.displayedName, name)));
    const { courtNameMatches, datasetMatches, courtMatches } = matchedCourts(query);
    const candidates = nameMatches.flatMap((person): JudgeCourtCandidate[] => {
      const evidence = evidenceFor(person, query, courtNameMatches, datasetMatches, courtMatches);
      return evidence.length ? [{
        person,
        matchedNames: names(person).filter((name) => compatibleName(query.displayedName, name)),
        evidence,
      }] : [];
    });
    const status = candidates.length === 1 ? "unique" : candidates.length > 1 ? "ambiguous" : "no_match";
    return {
      status,
      displayedName: query.displayedName,
      candidates,
      nameMatches,
      courtMatches,
      noMatchMayBeUnrecordedAssignment: status === "no_match",
    };
  }) as JudgeCourtServiceResolver;
  resolve.serving = serving;
  return resolve;
}
