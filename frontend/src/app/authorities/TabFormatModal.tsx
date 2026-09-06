import { useState } from "react";
import { tabLabel } from "../../../../shared/authorities-order.mjs";
import { Modal } from "@/app/components/modals/Modal";
import { Input } from "@/app/components/ui/input";
import type { AuthoritiesBuildSettings } from "./types";

export function TabFormatModal({ settings, busy, onSave, onClose }: {
  settings: AuthoritiesBuildSettings; busy: boolean;
  onSave: (settings: Partial<AuthoritiesBuildSettings>) => void; onClose: () => void;
}) {
  const [style, setStyle] = useState(settings.tabStyle);
  const [start, setStart] = useState(String(settings.tabStart ?? 1));
  const [prefix, setPrefix] = useState(settings.tabPrefix ?? "Tab ");
  const [labels, setLabels] = useState((settings.tabLabels ?? []).join("\n"));
  const number = Number(start);
  const valid = Number.isSafeInteger(number) && number >= 1 && number <= 10_000 &&
    prefix.length <= 80 && labels.split("\n").every((label) => label.length <= 100);
  const next = { tabStyle: style, tabStart: number, tabPrefix: prefix,
    tabLabels: labels ? labels.split("\n").map((label) => label.trim()) : [] };
  const submit = () => { if (valid && !busy) { onSave(next); onClose(); } };
  return <Modal open onClose={onClose} size="lg" breadcrumbs={["Tab labels"]}
    className="!h-fit max-h-[calc(100dvh-2rem)]"
    secondaryAction={{ label: "Cancel", onClick: onClose }}
    primaryAction={{ label: "Apply", disabled: busy || !valid, onClick: submit }}>
    <form onSubmit={(event) => { event.preventDefault(); submit(); }} className="space-y-4 pb-4">
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm font-medium">Numbering
          <select value={style} disabled={busy} onChange={(event) =>
            setStyle(event.target.value as AuthoritiesBuildSettings["tabStyle"])}
            className="mt-1 h-10 w-full rounded-md border border-gray-400 bg-white px-2">
            <option value="numeric">1, 2, 3</option><option value="alpha">A, B, C</option>
            <option value="lower-alpha">a, b, c</option><option value="roman">I, II, III</option>
            <option value="lower-roman">i, ii, iii</option>
          </select>
        </label>
        <label className="text-sm font-medium">Starting number
          <Input type="number" min={1} max={10_000} value={start} disabled={busy}
            onChange={(event) => setStart(event.target.value)} className="mt-1 h-10 border-gray-400" />
        </label>
      </div>
      <label className="block text-sm font-medium">Prefix
        <Input value={prefix} maxLength={80} disabled={busy}
          onChange={(event) => setPrefix(event.target.value)} className="mt-1 h-10 border-gray-400" />
      </label>
      <label className="block text-sm font-medium">Custom labels <span className="font-normal text-gray-500">(optional)</span>
        <textarea value={labels} disabled={busy} rows={4} onChange={(event) => setLabels(event.target.value)}
          aria-describedby="authority-tab-label-help"
          className="mt-1 w-full resize-y rounded-md border border-gray-400 p-2 font-mono text-sm" />
      </label>
      <p id="authority-tab-label-help" className="text-xs text-gray-600">One label per slot. Blank lines use the numbering pattern. Moving an authority does not move the label.</p>
      <output aria-label="Tab label preview" className="flex flex-wrap gap-2 rounded-md bg-gray-50 p-3 text-sm">
        {valid ? [1, 2, 3].map((slot) => <span key={slot} className="rounded border border-gray-300 bg-white px-2 py-1">
          {tabLabel(slot, style, next)}</span>) : "Enter a starting number from 1 to 10,000."}
      </output>
    </form>
  </Modal>;
}
