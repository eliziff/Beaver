import { ChevronDown, FileText, Plus, Scale, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ChoiceModalButton, JurisdictionModal } from "@/app/components/modals/JurisdictionModal";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";
import { TabList } from "@/app/components/ui/tabs";
import { COURT_JURISDICTIONS, registeredCourt, registeredLevel } from "@/app/lib/courtRegistry";
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

export function CourtRecordChooser({ profile, onProfile, creating = false, onCancel,
  jurisdictionOrder = [] }: {
  profile: CourtProfile; onProfile: (profileId: string) => void; creating?: boolean;
  onCancel?: () => void; jurisdictionOrder?: string[];
}) {
  const [dialog, setDialog] = useState<"jurisdiction" | "document" | "format" | undefined>(
    creating ? "jurisdiction" : undefined);
  const [documentId, setDocumentId] = useState(() => profile.documentLabel);
  const [jurisdiction, setJurisdiction] = useState(profile.jurisdiction);
  const [levelId, setLevelId] = useState(() => levelFor(profile).id);
  const choosing = useRef(false);
  const selected = selectionFor(profile);
  const jurisdictionProfiles = PROFILES.filter((item) => item.jurisdiction === jurisdiction);
  const levels = levelChoices(jurisdictionProfiles);
  const activeLevel = levels.some(({ id }) => id === levelId) ? levelId : levels[0]?.id;
  const documents = documentChoices(jurisdictionProfiles.filter((item) =>
    levelFor(item).id === activeLevel));
  const document = documents.find((item) => item.id === documentId) ?? documents[0];

  useEffect(() => {
    setDocumentId(profile.documentLabel); setJurisdiction(profile.jurisdiction);
    setLevelId(levelFor(profile).id);
  }, [profile]);

  function chooseJurisdiction(id: string) {
    const profiles = PROFILES.filter((item) => item.jurisdiction === id);
    choosing.current = true; setJurisdiction(id);
    if (profiles.length === 1) { onProfile(profiles[0].id); setDialog(undefined); return; }
    const firstLevel = levelChoices(profiles)[0]?.id;
    setLevelId(firstLevel ?? "");
    setDocumentId(documentChoices(profiles.filter((item) =>
      levelFor(item).id === firstLevel))[0]?.id ?? "");
    setDialog("document");
  }

  function chooseLevel(id: string) {
    setLevelId(id);
    setDocumentId(documentChoices(jurisdictionProfiles.filter((item) =>
      levelFor(item).id === id))[0]?.id ?? "");
  }

  function chooseDocument(id: string) {
    const profiles = documents.find((item) => item.id === id)?.profiles ?? [];
    choosing.current = true;
    if (profiles.length === 1) {
      onProfile(profiles[0].id); setDialog(undefined); return;
    }
    setDocumentId(id); setDialog("format");
  }

  function closeDialog(kind: "jurisdiction" | "document" | "format") {
    if (choosing.current) { choosing.current = false; return; }
    setDialog((current) => current === kind ? undefined : current);
    if (creating) onCancel?.();
  }

  return <>
    {!creating && <section className="flex flex-wrap gap-2 px-1" aria-label="Document format"
      data-court-record-chooser data-selected-profile={profile.id}>
      <ChoiceModalButton icon={<FileText className="h-4 w-4 shrink-0 text-gray-500" />}
        label="Document" value={selected.document}
        onClick={() => setDialog("jurisdiction")} />
      <ChoiceModalButton icon={<Scale className="h-4 w-4 shrink-0 text-gray-500" />}
        label="Format" value={selected.format}
        onClick={() => setDialog("format")} />
    </section>}
    <JurisdictionModal open={dialog === "jurisdiction"} value={jurisdiction}
      options={JURISDICTIONS} preferredKeys={jurisdictionOrder}
      onChange={chooseJurisdiction}
      onClose={() => closeDialog("jurisdiction")} />
    <SearchableChoiceModal open={dialog === "document"} title="Choose document"
      searchLabel="Search documents"
      controls={<><button type="button" onClick={() => setDialog("jurisdiction")}
        className="mb-2 min-h-9 rounded-md px-2 text-sm font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-900">
        {JURISDICTIONS.find(({ value }) => value === jurisdiction)?.label}
      </button>{levels.length > 1 && <TabList value={activeLevel} onValueChange={chooseLevel}
        options={levels.map(({ id, label }) => ({ value: id, label }))}
        ariaLabel="Court level" variant="dock"
        className="mb-2 min-h-0 border-0 bg-transparent px-0 py-0" />}</>}
      options={documents.map((item) => ({ value: item.id, label: item.label }))}
      size="2xl" value={documentId} onChange={(id) => id && chooseDocument(id)}
      onClose={() => closeDialog("document")} />
    {document && <SearchableChoiceModal open={dialog === "format"} title={`${document.label} format`}
      options={document.profiles.map((item) => ({ value: item.id, label: selectionFor(item).format }))}
      value={profile.id} searchable={false}
      onChange={(id) => { if (id) { choosing.current = true; onProfile(id); } setDialog(undefined); }}
      onClose={() => closeDialog("format")} />}
  </>;
}

const PROFILES = effectiveCourtProfiles().filter(({ selectable }) => selectable);
const AVAILABLE_JURISDICTIONS = new Set(PROFILES.map(({ jurisdiction }) => jurisdiction));
const JURISDICTIONS = COURT_JURISDICTIONS.filter(({ id }) => AVAILABLE_JURISDICTIONS.has(id))
  .map(({ id, label, preferenceKey }) => ({ value: id, label, preferenceKey }));

function documentChoices(profiles: CourtProfile[]) {
  const groups = new Map<string, { id: string; label: string; profiles: CourtProfile[] }>();
  for (const profile of profiles) {
    const document = profile.documentLabel;
    const current = groups.get(document) ?? { id: document, label: document, profiles: [] };
    current.profiles.push(profile);
    groups.set(document, current);
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function selectionFor(profile: CourtProfile) {
  const division = profile.division?.split("-").map((part) =>
    part[0]?.toUpperCase() + part.slice(1)).join(" ");
  return { document: profile.documentLabel,
    format: [...new Set([profile.courtAbbreviation, division, profile.role].filter(Boolean))]
      .join(" · ") };
}

const levelFor = ({ courtId }: CourtProfile) => registeredLevel(registeredCourt(courtId).levelId);
function levelChoices(profiles: CourtProfile[]) {
  return [...new Map(profiles.map((profile) => {
    const level = levelFor(profile);
    return [level.id, level];
  })).values()].sort((left, right) => left.order - right.order);
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
                <Button id={`add-${group.id}`} variant="ghost" size="compact" onClick={() => addParty(group)} className="w-fit text-sm">
                  <Plus className="h-4 w-4" aria-hidden="true" /> Add {group.role.toLowerCase()}
                </Button>
              </div>
            </section>
          );
        })}
      </div>
      {optional && (
        <Button id={`add-${optional.id}`} variant="outline" onClick={addOptionalGroup} className="mt-3">
          <Plus className="h-4 w-4" aria-hidden="true" /> Add {optional.role.toLowerCase()}
        </Button>
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
          ? <ModalTextarea {...common} rows={2} className="mt-1.5 min-h-20 font-normal" />
          : <Input {...common} className="mt-1.5 bg-white font-normal" />}
        {invalid && <span id={`cover-${item.id}-error`} className="mt-1 block text-sm font-normal text-red-700">Required</span>}
      </label>
    );
  });
}
