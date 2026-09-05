import { ChevronDown, FileText, Plus, Scale, SlidersHorizontal, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ChoiceModalButton, courtJurisdictionOptions } from "@/app/components/modals/JurisdictionModal";
import { Modal } from "@/app/components/modals/Modal";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";
import { TabList } from "@/app/components/ui/tabs";
import { registeredCourt, registeredJurisdiction, registeredLevel } from "@/app/lib/courtRegistry";
import { cn } from "@/app/lib/utils";
import { COURT_PROFILES } from "./profiles";
import type {
  CourtProfile,
  CasePartyGroup,
  CoverField,
  CoverIssueId,
  CoverValues,
  PartyContact,
} from "./types";
import { coverPartyGroups } from "./types";

export function CourtRecordChooser({ profile, onProfile, creating = false, onCancel,
  jurisdictionOrder = [] }: {
  profile: CourtProfile; onProfile: (profileId: string) => void; creating?: boolean;
  onCancel?: () => void; jurisdictionOrder?: string[];
}) {
  const [open, setOpen] = useState(creating), [query, setQuery] = useState("");
  const [choice, setChoice] = useState(() => ({ ...choiceFor(profile), jurisdiction: creating ? "" : profile.jurisdiction }));
  const selected = selectionFor(profile);
  const jurisdictionProfiles = PROFILES.filter((item) => item.jurisdiction === choice.jurisdiction);
  const levels = levelChoices(jurisdictionProfiles);
  const activeLevel = levels.some(({ id }) => id === choice.levelId)
    ? choice.levelId : levels[0]?.id;
  const documents = documentChoices(jurisdictionProfiles.filter((item) =>
    levelFor(item).id === activeLevel));
  const filteredDocuments = documents.filter(({ label }) => label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const hasFormatChoice = PROFILES.filter((item) => item.jurisdiction === profile.jurisdiction &&
    levelFor(item).id === levelFor(profile).id && item.documentFamily === profile.documentFamily).length > 1;
  const jurisdictions = [...JURISDICTIONS].sort((a, b) => {
    const left = jurisdictionOrder.indexOf(a.preferenceKey ?? a.value), right = jurisdictionOrder.indexOf(b.preferenceKey ?? b.value);
    return (left < 0 ? jurisdictionOrder.length : left) - (right < 0 ? jurisdictionOrder.length : right);
  });

  useEffect(() => { if (!creating) setChoice(choiceFor(profile)); }, [profile, creating]);

  function chooseProfile(next: CourtProfile) {
    onProfile(next.id); setOpen(false);
  }

  function chooseJurisdiction(id: string) {
    const profiles = PROFILES.filter((item) => item.jurisdiction === id);
    const nextLevels = levelChoices(profiles), nextLevel = nextLevels[0]?.id ?? "";
    setChoice({ jurisdiction: id, levelId: nextLevel, documentId: "" }); setQuery("");
  }

  function chooseLevel(id: string) {
    setChoice((current) => ({ ...current, levelId: id, documentId: "" })); setQuery("");
  }

  function chooseDocument(id: string) {
    const profiles = documents.find((item) => item.id === id)?.profiles ?? [];
    setChoice((current) => ({ ...current, documentId: id }));
    if (profiles.length === 1) { chooseProfile(profiles[0]); return; }
  }

  function closeDialog() {
    setOpen(false); setQuery("");
    setChoice(choiceFor(profile));
    if (creating) onCancel?.();
  }

  function openDialog() {
    setChoice(choiceFor(profile)); setQuery(""); setOpen(true);
  }

  return <>
    {!creating && <section className="flex flex-wrap gap-2 px-1" aria-label="Court record format"
      data-court-record-chooser data-selected-profile={profile.id}>
      <ChoiceModalButton icon={<Scale className="h-4 w-4 shrink-0 text-gray-500" />}
        label="Court" value={selected.court}
        onClick={openDialog} />
      <ChoiceModalButton icon={<FileText className="h-4 w-4 shrink-0 text-gray-500" />}
        label="Document" value={selected.document}
        onClick={openDialog} />
      {hasFormatChoice && <ChoiceModalButton
        icon={<SlidersHorizontal className="h-4 w-4 shrink-0 text-gray-500" />}
        label="Format" value={selected.format}
        onClick={openDialog} />}
    </section>}
    <Modal open={open} onClose={closeDialog} breadcrumbs={["Choose document"]} size="2xl">
      <label className="mb-3 block shrink-0 text-sm font-medium text-gray-800">Jurisdiction
        <select autoFocus aria-label="Jurisdiction" value={choice.jurisdiction} onChange={(event) => chooseJurisdiction(event.target.value)}
          className="mt-1 h-9 w-full rounded-md border border-gray-300 bg-white px-3 text-base font-normal text-gray-900 sm:text-sm">
          {!choice.jurisdiction && <option value="" disabled>Choose jurisdiction</option>}
          {jurisdictions.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {levels.length > 1 && <TabList value={activeLevel} onValueChange={chooseLevel}
        options={levels.map(({ id, label }) => ({ value: id, label }))}
        ariaLabel="Court level" variant="segmented"
        className="mb-2 min-h-0 shrink-0 px-0 py-1 [&_[role=tab]]:min-w-24" />}
      {documents.length > 8 && <Input type="search" aria-label="Search documents" value={query}
        onChange={(event) => setQuery(event.target.value)} className="mb-2 shrink-0" />}
      <div role="group" aria-label="Documents" className="min-h-0 space-y-1 overflow-y-auto pb-4">
        {!!query.trim() && !filteredDocuments.length && <p className="px-3 py-4 text-sm text-gray-600">No matching documents.</p>}
        {filteredDocuments.map((document) =>
          <div key={document.id}>
            <button type="button" aria-pressed={document.id === choice.documentId}
              onClick={() => chooseDocument(document.id)}
              className="flex min-h-10 w-full items-center rounded-md border border-gray-200 px-3 py-2 text-left text-sm hover:bg-gray-100 aria-pressed:bg-gray-100">
              {document.label}</button>
            {document.id === choice.documentId && document.profiles.length > 1 && <div role="group"
              aria-label={`${document.label} format`} className="my-2 space-y-1 border-s-2 border-gray-200 ps-3">
              <p className="text-sm font-medium text-gray-700">Format</p>
              {document.profiles.map((item) => <button key={item.id} type="button" onClick={() => chooseProfile(item)}
                aria-pressed={item.id === profile.id} className="block min-h-9 w-full rounded px-3 py-1.5 text-left text-sm hover:bg-gray-100 aria-pressed:bg-gray-100">
                {item.shortLabel}</button>)}
            </div>}
          </div>)}
      </div>
    </Modal>
  </>;
}

const PROFILES = COURT_PROFILES.filter(({ selectable }) => selectable);
const JURISDICTIONS = courtJurisdictionOptions(PROFILES.map(({ jurisdiction }) => jurisdiction));

function documentChoices(profiles: CourtProfile[]) {
  const groups = new Map<string, { id: string; label: string; profiles: CourtProfile[] }>();
  for (const profile of profiles) {
    const document = profile.documentFamily;
    const current = groups.get(document) ?? {
      id: document, label: profile.documentLabel, profiles: [],
    };
    current.profiles.push(profile);
    groups.set(document, current);
  }
  return [...groups.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function selectionFor(profile: CourtProfile) {
  return { court: profile.jurisdiction === "general"
      ? registeredJurisdiction(profile.jurisdiction).label : profile.court,
    document: profile.documentLabel,
    format: profile.shortLabel };
}

const levelFor = ({ courtId }: CourtProfile) => registeredLevel(registeredCourt(courtId).levelId);
const choiceFor = (profile: CourtProfile) => ({ jurisdiction: profile.jurisdiction,
  levelId: levelFor(profile).id, documentId: profile.documentFamily });
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
  onCover: (field: keyof CoverValues, value: string | string[] | CasePartyGroup[]) => void;
  onSaveFilingContact?: () => void;
  savingFilingContact?: boolean;
};

const PARTY_CONTACT_FIELDS = [
  ["name", "counselName"], ["address", "counselAddress"], ["phone", "counselPhone"],
  ["fax", "counselFax"], ["email", "counselEmail"],
] as const;

export function CourtRecordSetup({ profile, cover, missingFields, heading, onCover,
  onSaveFilingContact, savingFilingContact }: Props) {
  const styles = profile.cover.partyStyles;
  const styleId = cover.partyStyleId ?? (styles?.length === 1 ? styles[0].id : undefined);
  const fields = profile.cover.fields.filter((item) =>
    !item.partyStyleId || item.partyStyleId === styleId);
  const requiredFields = fields.filter((item) => item.required);
  const optionalFields = fields.filter((item) => !item.required);
  const style = styles?.find((item) => item.id === styleId);
  const groups = styles?.length ? coverPartyGroups(profile, cover) : [];
  const partyError = missingFields.has("partyStyleId") || missingFields.has("partyGroups") ||
    missingFields.has("partyContacts");
  const partiesIncomplete = !style || style.groups
    .filter((group) => !group.optional || group.id === profile.cover.filingGroupId)
    .some((group) => !groups.find((item) => item.id === group.id)
      ?.parties.some(({ name }) => name.trim()));
  const [partiesOpen, setPartiesOpen] = useState(partiesIncomplete || partyError);
  const partyProfileId = useRef(profile.id);
  useEffect(() => {
    if (partyProfileId.current !== profile.id) {
      partyProfileId.current = profile.id;
      setPartiesOpen(partiesIncomplete || partyError);
    }
  }, [partiesIncomplete, partyError, profile.id]);
  useEffect(() => { if (partyError) setPartiesOpen(true); }, [partyError]);
  const partySummary = groups.map((group) => {
    const names = group.parties.map(({ name }) => name.trim()).filter(Boolean);
    return names.length ? `${group.role}: ${names.join(", ")}` : "";
  }).filter(Boolean).join(" · ");
  return (
    <section className="rounded-xl border border-gray-200 bg-white shadow-sm" aria-labelledby="filing-heading">
      <div className="px-4 py-3.5">
        <h2 id="filing-heading" className="text-base font-semibold leading-6 text-gray-950">{heading}</h2>
      </div>
      {!!profile.cover.partyStyles?.length && (
        <details open={partiesOpen} onToggle={(event) => setPartiesOpen(event.currentTarget.open)}
          className="group border-t border-gray-100">
          <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-gray-950">Style of cause</span>
              <span className="block truncate text-xs text-gray-600" title={partySummary || undefined}>
                {partySummary || "Add parties"}
              </span>
            </span>
            <ChevronDown className="size-4 shrink-0 text-gray-500 group-open:rotate-180"
              aria-hidden="true" />
          </summary>
          <PartyEditor profile={profile} cover={cover} missingFields={missingFields} onCover={onCover} />
        </details>
      )}
      <div className="grid gap-x-3 gap-y-3 border-t border-gray-100 p-4 sm:grid-cols-2">
        <CoverFields fields={requiredFields} cover={cover} missingFields={missingFields} onCover={onCover} />
        <CoverFields fields={optionalFields} cover={cover} missingFields={missingFields} onCover={onCover} />
      </div>
      {onSaveFilingContact && <div className="flex justify-end border-t border-gray-100 px-4 py-3">
        <Button type="button" variant="outline" data-save-filing-details
          className="h-auto min-h-9 w-full whitespace-normal py-2 sm:h-9 sm:w-auto sm:py-0"
          disabled={savingFilingContact} onClick={onSaveFilingContact}>
          {savingFilingContact ? "Saving…" : "Save filing details for new records"}
        </Button>
      </div>}
    </section>
  );
}

function PartyEditor({ profile, cover, missingFields, onCover }: Omit<Props, "heading">) {
  const styles = profile.cover.partyStyles!;
  const activeStyle = styles.find((style) => style.id === cover.partyStyleId) ??
    (styles.length === 1 ? styles[0] : undefined);
  const groups = coverPartyGroups(profile, cover);
  const candidates = groups
    .filter((group) => !profile.cover.filingGroupId || group.id === profile.cover.filingGroupId)
    .flatMap((group) => group.parties
      .filter((party) => party.name.trim())
      .map((party) => ({ party, group })));
  const candidateKey = candidates.map(({ party }) => party.id).join("\0");
  const allowedKey = groups
    .filter((group) => !profile.cover.filingGroupId || group.id === profile.cover.filingGroupId)
    .flatMap((group) => group.parties.map(({ id }) => id)).join("\0");
  const inferredFiler = useRef(!cover.filingPartyIds?.length);
  const optional = activeStyle?.groups.find((group) => group.optional &&
    !groups.some((current) => current.id === group.id));

  const setGroups = (next: CasePartyGroup[]) => onCover("partyGroups", next);
  const focus = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

  useEffect(() => {
    const candidateIds = candidateKey ? candidateKey.split("\0") : [];
    const allowed = new Set(allowedKey ? allowedKey.split("\0") : []);
    const selected = (cover.filingPartyIds ?? []).filter((id) => allowed.has(id));
    const infer = candidateIds.length === 1 && !selected.length || inferredFiler.current &&
      (!!profile.cover.filingGroupId || candidateIds.length === 1);
    const next = infer ? candidateIds : inferredFiler.current ? [] : selected;
    if (next.join("\0") !== (cover.filingPartyIds ?? []).join("\0")) {
      onCover("filingPartyIds", next);
    }
  }, [allowedKey, candidateKey, cover.filingPartyIds, onCover, profile.cover.filingGroupId]);

  useEffect(() => {
    if (styles.length === 1 && !cover.partyStyleId) onCover("partyStyleId", styles[0].id);
  }, [cover.partyStyleId, onCover, styles]);

  function changeStyle(styleId: string) {
    const nextStyle = styles.find((style) => style.id === styleId);
    if (!nextStyle) return;
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
    setGroups(next);
    onCover("partyStyleId", styleId);
  }

  function changeName(groupId: string, partyId: string, name: string) {
    setGroups(groups.map((group) => group.id === groupId ? {
      ...group,
      parties: group.parties.map((party) => party.id === partyId ? { ...party, name } : party),
    } : group));
    if (!name.trim() && cover.filingPartyIds?.includes(partyId)) {
      inferredFiler.current = false;
      onCover("filingPartyIds", cover.filingPartyIds.filter((id) => id !== partyId));
    }
  }

  function changeContact(groupId: string, partyId: string, field: keyof PartyContact,
    value: string) {
    setGroups(groups.map((group) => group.id === groupId ? { ...group,
      parties: group.parties.map((party) => party.id === partyId
        ? { ...party, contact: { ...party.contact, [field]: value } } : party) } : group));
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
    if (cover.filingPartyIds?.includes(partyId)) {
      inferredFiler.current = false;
      onCover("filingPartyIds", cover.filingPartyIds.filter((id) => id !== partyId));
    }
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
    const removed = new Set(group.parties.map(({ id }) => id));
    if (cover.filingPartyIds?.some((id) => removed.has(id))) {
      inferredFiler.current = false;
      onCover("filingPartyIds", cover.filingPartyIds.filter((id) => !removed.has(id)));
    }
    focus(`add-${group.id}`);
  }

  return (
    <fieldset className="border-t border-gray-100 p-4">
      <legend className="sr-only">Parties</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {styles.length > 1 && (
          <label className="block text-sm font-medium leading-5 text-gray-700">
            Style of cause<span className="ml-1 text-red-600" aria-hidden="true">*</span>
            <select
              id="court-record-party-style"
              value={activeStyle?.id ?? ""}
              onChange={(event) => changeStyle(event.target.value)}
              aria-invalid={missingFields.has("partyStyleId") || undefined}
              aria-describedby={missingFields.has("partyStyleId") ? "party-style-error" : undefined}
              className={cn("mt-1.5 h-10 w-full rounded-lg border bg-white px-3 text-base font-normal text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-red-200",
                missingFields.has("partyStyleId") ? "border-red-500" : "border-gray-400 focus-visible:border-red-500")}
            >
              <option value="">Choose style</option>
              {styles.map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
            </select>
            {missingFields.has("partyStyleId") && <span id="party-style-error"
              className="mt-1 block text-sm font-normal text-red-700">Choose the style of cause.</span>}
          </label>
        )}
        {candidates.length > 1 && <fieldset className={cn("rounded-lg border px-3 py-2",
          missingFields.has("filingPartyIds") ? "border-red-500" : "border-gray-300")}>
          <legend className="px-1 text-sm font-medium leading-5 text-gray-700">
            Filing parties<span className="ml-1 text-red-600" aria-hidden="true">*</span>
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {candidates.map(({ party, group }) => <label key={party.id}
              className="flex min-h-7 items-center gap-2 text-sm text-gray-900">
              <input type="checkbox" value={party.id}
                checked={cover.filingPartyIds?.includes(party.id) ?? false}
                onChange={(event) => {
                  inferredFiler.current = false;
                  const selected = new Set(cover.filingPartyIds ?? []);
                  if (event.target.checked) selected.add(party.id);
                  else selected.delete(party.id);
                  onCover("filingPartyIds", candidates.map(({ party }) => party.id)
                    .filter((id) => selected.has(id)));
                }} className="size-4 accent-red-700" />
              <span>{party.name} <span className="text-gray-500">— {group.role}</span></span>
            </label>)}
          </div>
          {missingFields.has("filingPartyIds") && <p className="mt-1 text-sm text-red-700">
            Choose at least one filing party.
          </p>}
        </fieldset>}
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {groups.map((group) => {
          const definition = activeStyle?.groups.find((item) => item.id === group.id) ??
            styles.flatMap((style) => style.groups).find((item) => item.id === group.id);
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
                {group.parties.map((party, index) => <div key={party.id}>
                  <div className="flex items-end gap-2">
                    <label className="min-w-0 flex-1">
                      <span className="sr-only">{group.role} {index + 1}</span>
                      <Input id={`party-${party.id}`} value={party.name}
                        onChange={(event) => changeName(group.id, party.id, event.target.value)}
                        aria-invalid={invalid || undefined}
                        aria-describedby={invalid ? `party-${group.id}-error` : undefined}
                        className={cn("h-9 border-gray-400 bg-white font-normal md:text-base", invalid && "border-red-500")} />
                    </label>
                    {index > 0 ? <button type="button"
                      aria-label={`Remove ${group.role.toLowerCase()} ${index + 1}`}
                      onClick={() => removeParty(group, party.id)}
                      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-gray-500 outline-none hover:bg-gray-200 hover:text-gray-900 focus-visible:ring-2 focus-visible:ring-red-600">
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button> : <span className="h-10 w-10 shrink-0" aria-hidden="true" />}
                  </div>
                  {profile.cover.template === "abca-ap5" && !!cover.filingPartyIds?.length &&
                    !cover.filingPartyIds.includes(party.id) && !!party.name.trim() &&
                    <details data-contact-finding-id={`contact-${party.id}`}
                      className={cn("group mt-1.5 rounded-md border bg-white px-2.5 py-1.5",
                        missingFields.has("partyContacts") &&
                        [party.contact?.name, party.contact?.address, party.contact?.phone]
                          .some((value) => !value?.trim())
                          ? "border-red-500" : "border-gray-200")}>
                      <summary className="flex min-h-6 cursor-pointer items-center gap-2 text-xs font-medium text-gray-700 outline-none focus-visible:ring-2 focus-visible:ring-red-600">
                        <span className="min-w-0 flex-1 truncate">Contact for {party.name}{missingFields.has("partyContacts") &&
                          [party.contact?.name, party.contact?.address, party.contact?.phone]
                            .some((value) => !value?.trim()) &&
                          <span className="ml-1 text-red-700">Required</span>}</span>
                        <ChevronDown className="size-3.5 shrink-0 group-open:rotate-180" aria-hidden="true" />
                      </summary>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        {PARTY_CONTACT_FIELDS.map(([key, fieldId]) => {
                          const field = profile.cover.fields.find(({ id }) => id === fieldId)!;
                          const required = key === "name" || key === "address" || key === "phone";
                          const invalid = required && missingFields.has("partyContacts") &&
                            !party.contact?.[key]?.trim();
                          return <label key={key}
                            className={cn("text-xs font-medium text-gray-700",
                              field.multiline && "sm:col-span-2")}>
                            {field.label}{required && <span className="ml-1 text-red-600"
                              aria-hidden="true">*</span>}<span className="sr-only"> for {party.name}</span>
                            {field.multiline
                              ? <ModalTextarea rows={2} value={party.contact?.[key] ?? ""}
                                required={required} aria-invalid={invalid || undefined}
                                aria-label={`${field.label} for ${party.name}`}
                                onChange={(event) => changeContact(group.id, party.id, key,
                                  event.target.value)} className={cn("mt-1 min-h-16 font-normal",
                                  invalid && "border-red-500")} />
                              : <Input value={party.contact?.[key] ?? ""}
                                required={required} aria-invalid={invalid || undefined}
                                aria-label={`${field.label} for ${party.name}`}
                                onChange={(event) => changeContact(group.id, party.id, key,
                                  event.target.value)} className={cn("mt-1 h-8 bg-white font-normal",
                                  invalid && "border-red-500")} />}
                          </label>;
                        })}
                      </div>
                    </details>}
                </div>)}
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
