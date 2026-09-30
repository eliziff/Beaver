import { useId } from "react";
import type { AuthoritiesBuildSettings } from "./types";
import { cn } from "@/app/lib/utils";

export type AuthoritiesWordOptionsValue = {
  insertIntoDocument?: boolean;
  tableDelivery?: AuthoritiesBuildSettings["tableDelivery"];
  citationSuffix?: AuthoritiesBuildSettings["citationSuffix"];
};

const WORD_OUTPUTS = [
  { value: "book", label: "Build a book only", detail: "Keep the Word document as supplied." },
  { value: "marks", label: "Mark authorities in Word", detail: "Add citation marks to a Word copy, without a table." },
  { value: "table", label: "Mark authorities and add a table", detail: "Add citation marks and a Table of Authorities to a Word copy." },
  { value: "tabs", label: "Mark, add a table and append tab references", detail: "Also add the book tab beside each citation." },
] as const;

export function AuthoritiesWordOptions({ value, onChange, disabled = false, lockedDelivery }: {
  value: AuthoritiesWordOptionsValue;
  onChange: (value: AuthoritiesWordOptionsValue) => void;
  disabled?: boolean;
  lockedDelivery?: AuthoritiesBuildSettings["tableDelivery"];
}) {
  const name = useId();
  const selected = !value.insertIntoDocument ? "book"
    : value.tableDelivery === "native-marks" ? "marks"
      : value.citationSuffix && value.citationSuffix !== "none" ? "tabs" : "table";
  return <fieldset disabled={disabled}>
    <legend className="sr-only">Word document output</legend>
    <div className="space-y-1">
      {WORD_OUTPUTS.map(option => <label key={option.value}
        className={cn("flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-sm outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600",
          selected === option.value ? "bg-red-50" : "hover:bg-gray-50")}>
        <input type="radio" name={name} value={option.value} className="mt-1 accent-red-700"
          checked={selected === option.value} disabled={!!lockedDelivery && option.value === "marks"}
          onChange={() => onChange({ insertIntoDocument: option.value !== "book",
            tableDelivery: option.value === "marks" ? "native-marks"
              : lockedDelivery ?? (value.tableDelivery === "linked-append" ? "linked-append" : "native-append"),
            citationSuffix: option.value === "tabs" ? value.citationSuffix === "tab" ? "tab" : "book-tab" : "none" })} />
        <span><span className="block font-medium text-gray-950">{option.label}</span>
          <span className="block text-xs leading-5 text-gray-600">{option.detail}</span></span>
      </label>)}
    </div>
    {selected === "tabs" && <fieldset className="mt-4 px-3">
      <legend className="mb-1.5 text-sm font-medium text-gray-950">Tab reference</legend>
      {(["book-tab", "tab"] as const).map(suffix => <label key={suffix}
        className="flex min-h-10 cursor-pointer items-center gap-2 text-sm text-gray-800 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600">
        <input type="radio" name={`${name}-suffix`} className="accent-red-700"
          checked={(value.citationSuffix ?? "book-tab") === suffix}
          onChange={() => onChange({ ...value, citationSuffix: suffix })} />
        {suffix === "book-tab" ? "[Book of authorities Tab 1]" : "[Tab 1]"}
      </label>)}
    </fieldset>}
  </fieldset>;
}
