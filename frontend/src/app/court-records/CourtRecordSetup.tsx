import { ChevronDown, FileText, Plus, Scale, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { Input } from "@/app/components/ui/input";
import { cn } from "@/app/lib/utils";
import { effectiveCourtProfiles } from "./profiles";
import type {
  CourtProfile,
  CasePartyGroup,
  CoverField,
  CoverIssueId,
  CoverValues,
} from "./types";
import { coverPartyGroups } from "./types";

export function CourtRecordChooser({ profile, onProfile, creating = false, onCancel }: {
  profile: CourtProfile;
  onProfile: (profileId: string) => void;
  creating?: boolean;
  onCancel?: () => void;
}) {
  const [dialog, setDialog] = useState<"document" | "format" | undefined>(
    creating ? "document" : undefined);
  const [documentId, setDocumentId] = useState(() => selectionFor(profile).document);
  const choosing = useRef(false);
  const selected = selectionFor(profile);
  const document = DOCUMENTS.find((item) => item.id === documentId) ?? DOCUMENTS[0];

  useEffect(() => setDocumentId(selected.document), [selected.document]);

  function chooseDocument(id: string) {
    const profiles = DOCUMENTS.find((item) => item.id === id)?.profiles ?? [];
    choosing.current = true;
    if (profiles.length === 1) {
      onProfile(profiles[0].id);
      setDialog(undefined);
      return;
    }
    setDocumentId(id);
    setDialog("format");
  }

  function closeDialog(kind: "document" | "format") {
    if (choosing.current) { choosing.current = false; return; }
    setDialog((current) => current === kind ? undefined : current);
    if (creating) onCancel?.();
  }

  return (
    <>
      {!creating && <section className="flex flex-wrap gap-2 px-1" aria-label="Document format"
        data-court-record-chooser data-selected-profile={profile.id}>
        <ChoiceButton icon={FileText} label="Document" value={documentLabel(selected.document)} onClick={() => setDialog("document")} />
        <ChoiceButton icon={Scale} label="Format" value={selected.format} onClick={() => setDialog("format")} />
      </section>}
      <SearchableChoiceModal
        open={dialog === "document"}
        title="Choose document"
        searchLabel="Search documents"
        options={DOCUMENTS.map((item) => ({ value: item.id, label: item.label,
          group: item.group }))}
        value={documentId}
        onChange={(id) => id && chooseDocument(id)}
        onClose={() => closeDialog("document")}
      />
      <SearchableChoiceModal
        open={dialog === "format"}
        title={`${document.label} format`}
        options={document.profiles.map((item) => ({ value: item.id,
          label: selectionFor(item).format }))}
        value={profile.id}
        searchable={false}
        onChange={(id) => {
          if (id) { choosing.current = true; onProfile(id); }
          setDialog(undefined);
        }}
        onClose={() => closeDialog("format")}
      />
    </>
  );
}

function ChoiceButton({ icon: Icon, label, value, onClick }: {
  icon: typeof FileText;
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-label={`${label}: ${value}`} onClick={onClick} className="inline-flex min-h-11 min-w-0 items-center gap-2.5 rounded-lg border border-gray-300 bg-white px-3 text-left shadow-sm outline-none hover:border-gray-400 hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600">
      <Icon className="h-4 w-4 shrink-0 text-gray-500" aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</span>
        <span className="block max-w-64 truncate text-sm font-medium text-gray-950">{value}</span>
      </span>
    </button>
  );
}

const DOCUMENTS = documentChoices();

function documentChoices() {
  const groups = new Map<string, { id: string; label: string; profiles: CourtProfile[] }>();
  for (const profile of effectiveCourtProfiles().filter(({ id }) => id !== "general-court-record")) {
    const { document } = selectionFor(profile);
    const current = groups.get(document) ?? { id: document, label: document, profiles: [] };
    current.profiles.push(profile);
    groups.set(document, current);
  }
  return [...groups.values()].map((item) => ({ ...item,
    group: /\b(?:appeal|extracts?|condensed)\b/iu.test(item.label) || item.profiles.every(
      ({ courtId }) => courtId === "ab-ca" || courtId === "fca") ? "Appeal" : "Trial and applications",
  })).sort((left, right) => Number(left.group === "Appeal") - Number(right.group === "Appeal") ||
    left.label.localeCompare(right.label));
}

function documentLabel(id: string) {
  return DOCUMENTS.find((item) => item.id === id)?.label ?? id;
}

function selectionFor(profile: CourtProfile) {
  const id = profile.id;
  let document = profile.label;
  if (profile.family === "affidavit") document = "Affidavit with exhibits";
  else if (/motion-(?:record-(?:moving|responding)|reply)$/u.test(id)) document = "Motion record";
  else if (/application-record-(?:applicant|respondent)$/u.test(id)) document = "Application record";
  else if (/chambers-(?:filing|response)-set$/u.test(id)) document = "Civil chambers filing set";
  else if (/special-application-(?:applicant|respondent)-set$/u.test(id)) document = "Special Application filing set";
  else if (/review-appeal-(?:applicant|respondent)-set$/u.test(id)) document = "Judicial review or civil appeal set";
  else if (/commercial-(?:applicant|respondent)-set$/u.test(id)) document = "Commercial List filing set";
  else if (/extracts-(?:appellant|respondent|intervener)$/u.test(id)) document = "Extracts of key evidence";
  else if (id.startsWith("fca-leave-")) document = "Motion for leave to appeal record";
  const court = profile.jurisdiction === "general" ? "General" : profile.courtAbbreviation;
  const position = profile.role && !["Appellant", "Plaintiff or party directed by the Court"].includes(profile.role)
    ? ` · ${profile.role}` : "";
  const stage = profile.variant === "reply" ? " · Reply" : "";
  return { document, format: `${court}${position}${stage}` };
}

type Props = {
  profile: CourtProfile;
  cover: CoverValues;
  missingFields: Set<CoverIssueId>;
  heading: string;
  onCover: (field: keyof CoverValues, value: string | CasePartyGroup[]) => void;
};

export function CourtRecordSetup({ profile, cover, missingFields, heading, onCover }: Props) {
  const styleId = cover.partyStyleId ?? profile.cover.partyStyles?.[0]?.id;
  const fields = profile.cover.fields.filter((item) =>
    !item.partyStyleId || item.partyStyleId === styleId);
  const requiredFields = fields.filter((item) => item.required);
  const optionalFields = fields.filter((item) => !item.required);
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-labelledby="filing-heading">
      <div className="px-4 py-3.5">
        <h2 id="filing-heading" className="text-base font-semibold leading-6 text-gray-950">{heading}</h2>
      </div>
      {!!profile.cover.partyStyles?.length && (
        <PartyEditor profile={profile} cover={cover} missingFields={missingFields} onCover={onCover} />
      )}
      <div className="grid gap-x-3 gap-y-3 border-t border-gray-100 p-4 sm:grid-cols-2">
        <CoverFields fields={requiredFields} cover={cover} missingFields={missingFields} onCover={onCover} />
      </div>
      {!!optionalFields.length && (
        <details className="group border-t border-gray-100">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between px-4 py-2.5 text-sm font-medium text-gray-700 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
            More details <ChevronDown className="h-4 w-4 motion-safe:transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="grid gap-x-3 gap-y-3 border-t border-gray-100 p-4 sm:grid-cols-2">
            <CoverFields fields={optionalFields} cover={cover} missingFields={missingFields} onCover={onCover} />
          </div>
        </details>
      )}
    </section>
  );
}

function PartyEditor({ profile, cover, missingFields, onCover }: Omit<Props, "heading">) {
  const styles = profile.cover.partyStyles!;
  const activeStyle = styles.find((style) => style.id === cover.partyStyleId) ?? styles[0];
  const groups = coverPartyGroups(profile, cover);
  const candidates = groups
    .filter((group) => !profile.cover.filingGroupId || group.id === profile.cover.filingGroupId)
    .flatMap((group) => group.parties
      .filter((party) => party.name.trim())
      .map((party) => ({ party, group })));
  const onlyCandidateId = candidates.length === 1 ? candidates[0]?.party.id : undefined;
  const inferredFiler = useRef<string | undefined>(undefined);
  const optional = activeStyle.groups.find((group) => group.optional &&
    !groups.some((current) => current.id === group.id));

  const setGroups = (next: CasePartyGroup[]) => onCover("partyGroups", next);
  const focus = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

  useEffect(() => {
    if (onlyCandidateId && !cover.filingPartyId) {
      inferredFiler.current = onlyCandidateId;
      onCover("filingPartyId", onlyCandidateId);
    } else if (!onlyCandidateId && inferredFiler.current &&
        inferredFiler.current === cover.filingPartyId) {
      inferredFiler.current = undefined;
      onCover("filingPartyId", "");
    }
  }, [cover.filingPartyId, onCover, onlyCandidateId]);

  function changeStyle(styleId: string) {
    const nextStyle = styles.find((style) => style.id === styleId)!;
    const current = new Map(groups.map((group) => [group.id, group]));
    const next = nextStyle.groups.flatMap((definition) => {
      const existing = current.get(definition.id);
      if (definition.optional && !existing) return [];
      return [{
        id: definition.id,
        role: definition.role,
        roleBelow: definition.roleBelow,
        parties: existing?.parties ?? [{ id: `${definition.id}-1`, name: "" }],
      }];
    });
    onCover("partyStyleId", styleId);
    setGroups(next);
  }

  function changeName(groupId: string, partyId: string, name: string) {
    setGroups(groups.map((group) => group.id === groupId ? {
      ...group,
      parties: group.parties.map((party) => party.id === partyId ? { ...party, name } : party),
    } : group));
    if (!name.trim() && cover.filingPartyId === partyId) onCover("filingPartyId", "");
  }

  function addParty(group: CasePartyGroup) {
    const id = `${group.id}-${globalThis.crypto.randomUUID()}`;
    setGroups(groups.map((current) => current.id === group.id
      ? { ...current, parties: [...current.parties, { id, name: "" }] }
      : current));
    focus(`party-${id}`);
  }

  function removeParty(group: CasePartyGroup, partyId: string) {
    setGroups(groups.map((current) => current.id === group.id
      ? { ...current, parties: current.parties.filter((party) => party.id !== partyId) }
      : current));
    if (cover.filingPartyId === partyId) onCover("filingPartyId", "");
    focus(`add-${group.id}`);
  }

  function addOptionalGroup() {
    if (!optional) return;
    const id = `${optional.id}-${globalThis.crypto.randomUUID()}`;
    setGroups([...groups, {
      id: optional.id,
      role: optional.role,
      roleBelow: optional.roleBelow,
      parties: [{ id, name: "" }],
    }]);
    focus(`party-${id}`);
  }

  function removeOptionalGroup(group: CasePartyGroup) {
    setGroups(groups.filter((current) => current.id !== group.id));
    if (group.parties.some((party) => party.id === cover.filingPartyId)) onCover("filingPartyId", "");
    focus(`add-${group.id}`);
  }

  return (
    <fieldset className="border-t border-gray-100 p-4">
      <legend className="sr-only">Parties</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {styles.length > 1 && (
          <label className="block text-sm font-medium leading-5 text-gray-700">
            Party style
            <select
              value={activeStyle.id}
              onChange={(event) => changeStyle(event.target.value)}
              className="mt-1.5 h-10 w-full rounded-lg border border-gray-400 bg-white px-3 text-base font-normal text-gray-900 outline-none focus-visible:border-red-500 focus-visible:ring-2 focus-visible:ring-red-200"
            >
              {styles.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
            </select>
          </label>
        )}
        {candidates.length > 1 && <label className="block text-sm font-medium leading-5 text-gray-700">
          Filing party<span className="ml-1 text-red-600" aria-hidden="true">*</span>
          <select
            id="cover-filingPartyId"
            value={cover.filingPartyId ?? ""}
            onChange={(event) => {
              inferredFiler.current = undefined;
              onCover("filingPartyId", event.target.value);
            }}
            aria-invalid={missingFields.has("filingPartyId") || undefined}
            aria-describedby={missingFields.has("filingPartyId") ? "filing-party-error" : undefined}
            className={cn(
              "mt-1.5 h-10 w-full rounded-lg border bg-white px-3 text-base font-normal text-gray-900 outline-none focus-visible:ring-2",
              missingFields.has("filingPartyId")
                ? "border-red-500 focus-visible:ring-red-200"
                : "border-gray-400 focus-visible:border-red-500 focus-visible:ring-red-200",
            )}
          >
            <option value="">Choose party</option>
            {candidates.map(({ party, group }) => (
              <option key={party.id} value={party.id}>{party.name} — {group.role}</option>
            ))}
          </select>
          {missingFields.has("filingPartyId") && <span id="filing-party-error" className="mt-1 block text-sm font-normal text-red-700">Choose the party filing this record.</span>}
        </label>}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {groups.map((group) => {
          const definition = activeStyle.groups.find((item) => item.id === group.id);
          const required = !definition?.optional || group.id === profile.cover.filingGroupId;
          const invalid = required && missingFields.has("partyGroups") &&
            !group.parties.some((party) => party.name.trim());
          return (
            <section key={group.id} data-party-group={group.role}
              data-party-group-id={group.id} aria-labelledby={`party-group-${group.id}`}
              className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5">
              <div className="flex min-h-7 items-start justify-between gap-2">
                <h3 id={`party-group-${group.id}`} className="text-sm font-semibold text-gray-950">
                  {group.role}{required && <><span className="ml-1 text-red-600" aria-hidden="true">*</span><span className="sr-only"> required</span></>}
                  {group.roleBelow && <span className="block text-xs font-normal text-gray-500">{group.roleBelow} below</span>}
                </h3>
                {definition?.optional && !required && (
                  <button type="button" aria-label={`Remove ${group.role.toLowerCase()} group`} onClick={() => removeOptionalGroup(group)} className="inline-flex min-h-8 items-center rounded-md px-2 text-xs font-medium text-gray-600 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-red-600">
                    Remove
                  </button>
                )}
              </div>
              <div className="mt-1.5 grid gap-1.5">
                {group.parties.map((party, index) => (
                  <div key={party.id} className="flex items-end gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="sr-only">{group.role} {index + 1}</span>
                      <Input
                        id={`party-${party.id}`}
                        value={party.name}
                        onChange={(event) => changeName(group.id, party.id, event.target.value)}
                        aria-invalid={invalid || undefined}
                        aria-describedby={invalid ? `party-${group.id}-error` : undefined}
                        className={cn("h-9 border-gray-400 bg-white font-normal md:text-base", invalid && "border-red-500")}
                      />
                    </label>
                    {index > 0 && (
                      <button type="button" aria-label={`Remove ${group.role.toLowerCase()} ${index + 1}`} onClick={() => removeParty(group, party.id)} className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-gray-200 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-red-600">
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                ))}
                {invalid && <p id={`party-${group.id}-error`} className="text-sm text-red-700">Enter at least one name.</p>}
                <button id={`add-${group.id}`} type="button" onClick={() => addParty(group)} className="inline-flex h-8 w-fit items-center gap-1.5 rounded-md px-1.5 text-sm font-medium text-gray-700 outline-none hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-red-600">
                  <Plus className="h-4 w-4" aria-hidden="true" /> Add {group.role.toLowerCase()}
                </button>
              </div>
            </section>
          );
        })}
      </div>
      {optional && (
        <button id={`add-${optional.id}`} type="button" onClick={addOptionalGroup} className="mt-3 inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-red-600">
          <Plus className="h-4 w-4" aria-hidden="true" /> Add {optional.role.toLowerCase()}
        </button>
      )}
    </fieldset>
  );
}

function CoverFields({ fields, cover, missingFields, onCover }: {
  fields: CoverField[];
  cover: CoverValues;
  missingFields: Set<CoverIssueId>;
  onCover: Props["onCover"];
}) {
  return fields.map((item) => {
    const invalid = missingFields.has(item.id);
    const common = {
      id: `cover-${item.id}`,
      value: cover[item.id] ?? "",
      placeholder: item.placeholder,
      required: item.required,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onCover(item.id, event.target.value),
      "aria-invalid": invalid || undefined,
      "aria-describedby": invalid ? `cover-${item.id}-error` : undefined,
    };
    return (
      <label key={item.id} className={cn("block text-sm font-medium leading-5 text-gray-700", item.multiline && "sm:col-span-2")}>
        {item.label}{item.required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
        {item.multiline
          ? <textarea {...common} rows={2} className={cn("mt-1.5 w-full rounded-lg border bg-white px-3 py-2 text-base font-normal leading-6 text-gray-900 outline-none focus-visible:ring-2", invalid ? "border-red-500 focus-visible:ring-red-200" : "border-gray-400 focus-visible:border-red-500 focus-visible:ring-red-200")} />
          : <Input {...common} className={cn("mt-1.5 h-10 border-gray-400 bg-white font-normal md:text-base", invalid && "border-red-500")} />}
        {invalid && <span id={`cover-${item.id}-error`} className="mt-1 block text-sm font-normal text-red-700">Required</span>}
      </label>
    );
  });
}
