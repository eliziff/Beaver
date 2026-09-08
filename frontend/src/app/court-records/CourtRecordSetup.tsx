import { ChevronDown } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";
import { CourtChoiceModal, type CourtChoice } from "@/app/components/modals/CourtChoiceModal";
import { ModalTextarea } from "@/app/components/modals/ModalTextarea";
import { Input } from "@/app/components/ui/input";
import { Button } from "@/app/components/ui/button";
import { registeredCourt, registeredJurisdiction, registeredLevel } from "@/app/lib/courtRegistry";
import { cn } from "@/app/lib/utils";
import { CourtRecordStepHeading } from "./CourtRecordStepHeading";
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
  const [open, setOpen] = useState(creating), chosen = useRef(false);
  const court = profile.jurisdiction === "general"
    ? registeredJurisdiction(profile.jurisdiction).label : profile.court;
  const variants = FAMILIES.get(familyKey(profile))!;

  return <>
    {!creating && <section className="flex flex-wrap gap-2 px-1" aria-label="Court record format"
      data-court-record-chooser data-selected-profile={profile.id}>
      <Button type="button" variant="outline" aria-haspopup="dialog"
        aria-label={`Change document: ${court}, ${profile.documentLabel}`}
        className="h-auto min-h-9 max-w-full whitespace-normal text-left font-normal"
        onClick={() => setOpen(true)}>
        <span>{court} · {profile.documentLabel}</span>
        <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
      </Button>
      {variants.length > 1 && <select aria-label="Party" value={profile.id} onChange={(event) => onProfile(event.target.value)}
        className="h-9 rounded-md border border-gray-300 bg-white px-2 text-sm">
        {variants.map((variant) => <option key={variant.id} value={variant.id}>{variant.shortLabel}</option>)}
      </select>}
    </section>}
    <CourtChoiceModal open={open} title="Choose document" searchLabel="Search documents"
      value={creating ? null : familyKey(profile)} options={COURT_RECORD_CHOICES}
      preferredKeys={jurisdictionOrder}
      onClose={() => { setOpen(false); if (creating && !chosen.current) onCancel?.(); }}
      onChange={(key) => { chosen.current = true; setOpen(false);
        const family = FAMILIES.get(key)!;
        onProfile(family.find(({ id }) => id === profile.id)?.id ?? family[0].id); }} />
  </>;
}

/** One document per court and family; the party (moving, responding, applicant…) is chosen inside the option. */
const familyKey = ({ courtId, documentFamily }: CourtProfile) => `${courtId}|${documentFamily}`;
const FAMILIES = new Map<string, CourtProfile[]>();
for (const profile of COURT_PROFILES.filter(({ selectable }) => selectable))
  FAMILIES.set(familyKey(profile), [...(FAMILIES.get(familyKey(profile)) ?? []), profile]);
const COURT_RECORD_CHOICES: CourtChoice[] = [...FAMILIES.entries()]
  .map(([key, family]) => ({ key, family, level: registeredLevel(registeredCourt(family[0].courtId).levelId),
    label: [...family].sort((a, b) => a.documentLabel.length - b.documentLabel.length)[0].documentLabel }))
  .sort((left, right) => left.level.order - right.level.order || left.label.localeCompare(right.label))
  .map(({ key, family, level, label }) => ({ value: key, label, jurisdictionId: family[0].jurisdiction,
    group: level.label, keywords: family.map(({ court, courtAbbreviation, shortLabel }) =>
      `${court} ${courtAbbreviation} ${shortLabel}`).join(" ") }));

type Props = {
  profile: CourtProfile;
  cover: CoverValues;
  missingFields: Set<CoverIssueId>;
  heading: string;
  step?: number;
  onCover: (field: keyof CoverValues, value: string | string[] | CasePartyGroup[]) => void;
  onSaveFilingContact?: () => void;
  savingFilingContact?: boolean;
};

const PARTY_CONTACT_FIELDS = [
  ["name", "counselName"], ["address", "counselAddress"], ["phone", "counselPhone"],
  ["fax", "counselFax"], ["email", "counselEmail"],
] as const;

export function CourtRecordSetup({ profile, cover, missingFields, heading, step, onCover,
  onSaveFilingContact, savingFilingContact }: Props) {
  const styles = profile.cover.partyStyles;
  const styleId = cover.partyStyleId ?? (styles?.length === 1 ? styles[0].id : undefined);
  const fields = profile.cover.fields.filter((item) =>
    !item.partyStyleId || item.partyStyleId === styleId);
  const caseFields = fields.filter(({ id }) => !id.startsWith("counsel") && !id.startsWith("otherCounsel"));
  const contacts = [
    ["Filing contact", fields.filter(({ id }) => id.startsWith("counsel"))],
    ["Other party’s contact", fields.filter(({ id }) => id.startsWith("otherCounsel"))],
  ] as const;
  return (
    <section className="rounded-lg border border-gray-200 bg-white" aria-labelledby="filing-heading">
      <div className="px-4 py-3.5">
        <CourtRecordStepHeading id="filing-heading" step={step}>{heading}</CourtRecordStepHeading>
      </div>
      {!!profile.cover.partyStyles?.length && (
        <PartyEditor profile={profile} cover={cover} missingFields={missingFields} onCover={onCover} />
      )}
      {!!caseFields.length && <div className="grid gap-3 border-t border-gray-100 p-4 sm:grid-cols-2">
        <CoverFields fields={caseFields} cover={cover} missingFields={missingFields} onCover={onCover} />
      </div>}
      {contacts.some(([, items]) => items.length) && <div className="grid gap-6 px-4 pb-4 sm:grid-cols-2">
      {contacts.map(([label, contactFields]) => !!contactFields.length && <fieldset key={label} className="min-w-0">
        <legend className="mb-3 text-sm font-semibold text-gray-950">{label}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <CoverFields fields={contactFields} cover={cover} missingFields={missingFields} onCover={onCover} />
        </div>
      </fieldset>)}
      {profile.cover.template === "abca-ap5" && !!cover.filingPartyIds?.length &&
        <OtherPartyContacts profile={profile} cover={cover} missingFields={missingFields} onCover={onCover} />}
      </div>}
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
  const definitions: Array<{ id: string; role: string; roleBelow?: string; optional?: boolean }> =
    activeStyle?.groups ?? groups;
  const candidates = groups
    .filter((group) => !profile.cover.filingGroupId || group.id === profile.cover.filingGroupId)
    .flatMap((group) => group.parties
      .filter((party) => party.name.trim())
      .map((party) => ({ party, group })));

  /** One name per line, the way the names stand in the style of cause on the cover. */
  function changeNames(definition: (typeof definitions)[number], value: string) {
    const previous = groups.find((group) => group.id === definition.id)?.parties ?? [];
    const parties = value.split("\n").map((name, index) =>
      ({ ...(previous[index] ?? { id: `${definition.id}-${index + 1}` }), name }));
    const kept = groups.filter((group) => group.id !== definition.id);
    const next = value.trim() || !definition.optional ? [...kept, { id: definition.id,
      role: definition.role, roleBelow: definition.roleBelow, parties }] : kept;
    onCover("partyGroups", definitions.flatMap((item) =>
      next.filter((group) => group.id === item.id)));
    const filers = next.filter((group) => !profile.cover.filingGroupId ||
      group.id === profile.cover.filingGroupId).flatMap((group) => group.parties.filter((party) => party.name.trim()));
    const selected = filers.filter((party) => cover.filingPartyIds?.includes(party.id));
    onCover("filingPartyIds", (selected.length ? selected : filers.length === 1 ? filers : []).map(({ id }) => id));
  }

  function changeStyle(styleId: string) {
    const nextStyle = styles.find((style) => style.id === styleId);
    if (!nextStyle) return;
    const current = new Map(groups.map((group) => [group.id, group]));
    onCover("partyGroups", nextStyle.groups.flatMap((definition) => {
      const existing = current.get(definition.id);
      return existing ? [{ ...existing, role: definition.role,
        roleBelow: definition.roleBelow }] : [];
    }));
    onCover("partyStyleId", styleId);
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
        {candidates.length > 1 && <fieldset>
          <legend className="mb-1.5 text-sm font-medium leading-5 text-gray-700">
            Filing parties<span className="ml-1 text-red-600" aria-hidden="true">*</span>
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {candidates.map(({ party, group }) => <label key={party.id}
              className="flex min-h-7 items-center gap-2 text-sm text-gray-900">
              <input type="checkbox" value={party.id}
                checked={cover.filingPartyIds?.includes(party.id) ?? false}
                onChange={(event) => {
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
        {definitions.map((definition) => {
          const group = groups.find((item) => item.id === definition.id);
          const required = !definition.optional || definition.id === profile.cover.filingGroupId;
          const invalid = required && missingFields.has("partyGroups") &&
            !group?.parties.some((party) => party.name.trim());
          return (
            <label key={definition.id} data-party-group={definition.role}
              data-party-group-id={definition.id} className="block min-w-0 text-sm font-semibold text-gray-950">
              {definition.role}{required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
              {definition.roleBelow && <span className="block text-xs font-normal text-gray-500">
                {definition.roleBelow} below
              </span>}
              <ModalTextarea id={`party-${definition.id}`} rows={2}
                value={(group?.parties ?? []).map(({ name }) => name).join("\n")}
                aria-label={`${definition.role} names, one per line`}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? `party-${definition.id}-error` : undefined}
                onChange={(event) => changeNames(definition, event.target.value)}
                className={cn("mt-1.5 min-h-20 font-normal", invalid && "border-red-500")} />
              {invalid && <span id={`party-${definition.id}-error`}
                className="mt-1 block text-sm font-normal text-red-700">Required</span>}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function OtherPartyContacts({ profile, cover, missingFields, onCover }: Omit<Props, "heading">) {
  const groups = coverPartyGroups(profile, cover);
  function changeContact(groupId: string, partyId: string, field: keyof PartyContact,
    value: string) {
    onCover("partyGroups", groups.map((group) => group.id === groupId ? { ...group,
      parties: group.parties.map((party) => party.id === partyId
        ? { ...party, contact: { ...party.contact, [field]: value } } : party) } : group));
  }

  return groups.flatMap((group) => group.parties.filter((party) =>
    !cover.filingPartyIds?.includes(party.id) && party.name.trim()).map((party) => (
    <fieldset key={party.id} data-contact-finding-id={`contact-${party.id}`} className="min-w-0">
      <legend className="mb-3 text-sm font-semibold text-gray-950">Contact for {party.name}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {PARTY_CONTACT_FIELDS.map(([key, fieldId]) => {
          const field = profile.cover.fields.find(({ id }) => id === fieldId)!;
          const required = key === "name" || key === "address" || key === "phone";
          const invalid = required && missingFields.has("partyContacts") &&
            !party.contact?.[key]?.trim();
          return <label key={key}
            className={cn("text-sm font-medium leading-5 text-gray-700",
              (field.multiline || key === "name" || key === "email") && "sm:col-span-2")}>
            {field.label}{required && <span className="ml-1 text-red-600"
              aria-hidden="true">*</span>}<span className="sr-only"> for {party.name}</span>
            {field.multiline
              ? <ModalTextarea rows={2} value={party.contact?.[key] ?? ""}
                required={required} aria-invalid={invalid || undefined}
                aria-label={`${field.label} for ${party.name}`}
                onChange={(event) => changeContact(group.id, party.id, key,
                  event.target.value)} className={cn("mt-1.5 min-h-20 font-normal",
                  invalid && "border-red-500")} />
              : <Input value={party.contact?.[key] ?? ""}
                required={required} aria-invalid={invalid || undefined}
                aria-label={`${field.label} for ${party.name}`}
                onChange={(event) => changeContact(group.id, party.id, key,
                  event.target.value)} className={cn("mt-1.5 bg-white font-normal",
                  invalid && "border-red-500")} />}
          </label>;
        })}
      </div>
    </fieldset>
  )));
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
      "aria-label": item.label,
    };
    return (
      <label key={item.id} className={cn("block text-sm font-medium leading-5 text-gray-700", (item.multiline || /counsel(?:Name|Email)$/iu.test(item.id)) && "sm:col-span-2")}>
        {item.label.replace(/^Other party[’']s (.)/u, (_match, first: string) => first.toUpperCase())}{item.required && <span className="ml-1 text-red-600" aria-hidden="true">*</span>}
        {item.multiline
          ? <ModalTextarea {...common} rows={2} className="mt-1.5 min-h-20 font-normal" />
          : <Input {...common} className="mt-1.5 bg-white font-normal" />}
        {invalid && <span id={`cover-${item.id}-error`} className="mt-1 block text-sm font-normal text-red-700">Required</span>}
      </label>
    );
  });
}
