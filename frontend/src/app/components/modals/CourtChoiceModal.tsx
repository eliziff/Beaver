import { useState } from "react";
import { COURT_JURISDICTIONS } from "@/app/lib/courtRegistry";
import { SearchableChoiceModal } from "./ModalSelect";

export type CourtChoice = {
  value: string; label: string; jurisdictionId: string;
  group?: string; description?: string; keywords?: string;
};

/** Shared jurisdiction-first court picker: one modal, jurisdiction rail then documents. */
export function CourtChoiceModal({ open, onClose, title, searchLabel, value, options,
  preferredKeys = [], onChange }: {
  open: boolean; onClose: () => void; title: string; searchLabel: string;
  value: string | null; options: readonly CourtChoice[]; preferredKeys?: readonly string[];
  onChange: (value: string) => void;
}) {
  const [picked, setPicked] = useState<string>();
  const present = new Set(options.map(({ jurisdictionId }) => jurisdictionId));
  const rank = ({ id, preferenceKey }: { id: string; preferenceKey?: string }) => {
    const index = preferredKeys.indexOf(preferenceKey ?? id);
    return index < 0 ? preferredKeys.length : index;
  };
  const jurisdictions = COURT_JURISDICTIONS.filter(({ id }) => present.has(id))
    .sort((a, b) => rank(a) - rank(b) || a.order - b.order);
  const active = picked ?? options.find((option) => option.value === value)?.jurisdictionId
    ?? jurisdictions[0]?.id ?? "";
  const visible = options.filter((option) => option.jurisdictionId === active);
  const close = () => { setPicked(undefined); onClose(); };
  return <SearchableChoiceModal open={open} onClose={close} title={title} value={value}
    searchLabel={searchLabel} searchable={visible.length > 8} size="2xl"
    className="!h-fit min-h-[min(28rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)]"
    options={visible}
    onChange={(next) => { if (next) { setPicked(undefined); onChange(next); } }}
    leadPanel={<div role="group" aria-label="Jurisdiction" className="grid gap-0.5">
      {jurisdictions.map((jurisdiction) => <button key={jurisdiction.id} type="button"
        aria-pressed={jurisdiction.id === active} onClick={() => setPicked(jurisdiction.id)}
        className="min-h-9 rounded-md px-2 py-1.5 text-left text-sm text-gray-700 outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-700 aria-pressed:bg-gray-100 aria-pressed:font-medium aria-pressed:text-gray-950">
        {jurisdiction.label}</button>)}
    </div>} />;
}
