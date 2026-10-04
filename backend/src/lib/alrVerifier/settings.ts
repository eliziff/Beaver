// ALR Quote Verifier settings: the Python app's DEFAULT_GUI_SETTINGS (gui.py) that affect a run.
export const RUN_MODES = ["high_accuracy", "economy", "ultra_economy", "free"] as const;
export const EXPORT_DETAILS = ["display", "display-json", "diagnostic-hidden", "diagnostic"] as const;
export const FRAGMENT_MODES = ["all", "pinpointless", "off"] as const;
export const PROPOSITION_MODES = ["passage_since_prior_note", "footnote_sentence"] as const;

export type RunMode = typeof RUN_MODES[number];
export type ExportDetail = typeof EXPORT_DETAILS[number];
export type FragmentMode = typeof FRAGMENT_MODES[number];
export type PropositionMode = typeof PROPOSITION_MODES[number];

export type AlrSettings = {
  run_mode: RunMode;
  supra_linking: "safe" | "aggressive";
  llm_cache: boolean;
  frag_mode: FragmentMode;
  proposition_mode: PropositionMode;
  pdf_input: boolean;
  a2aj: boolean;
  local_only: boolean;
  us_uk_case_lookup: boolean;
  export_detail: ExportDetail;
  parallel_files: "auto" | number;
  fn_filter: string;
};

export const DEFAULT_ALR_SETTINGS: AlrSettings = {
  run_mode: "high_accuracy", supra_linking: "safe", llm_cache: true, frag_mode: "all",
  proposition_mode: "passage_since_prior_note", pdf_input: false, a2aj: true, local_only: false,
  us_uk_case_lookup: true, export_detail: "diagnostic-hidden", parallel_files: "auto", fn_filter: "",
};

const pick = <T extends string>(values: readonly T[], value: unknown, fallback: T) =>
  values.includes(value as T) ? value as T : fallback;

/** Unknown or invalid values fall back to the defaults, as the Python app's settings loader does. */
export function alrSettings(value: Partial<Record<keyof AlrSettings, unknown>> = {}): AlrSettings {
  const d = DEFAULT_ALR_SETTINGS;
  const bool = (key: keyof AlrSettings) => typeof value[key] === "boolean" ? value[key] as boolean : d[key] as boolean;
  const parallel = value.parallel_files;
  const settings: AlrSettings = {
    run_mode: pick(RUN_MODES, value.run_mode, d.run_mode),
    supra_linking: value.supra_linking === "aggressive" ? "aggressive" : "safe",
    llm_cache: bool("llm_cache"), frag_mode: pick(FRAGMENT_MODES, value.frag_mode, d.frag_mode),
    proposition_mode: pick(PROPOSITION_MODES, value.proposition_mode, d.proposition_mode),
    pdf_input: bool("pdf_input"), a2aj: bool("a2aj"), local_only: bool("local_only"),
    us_uk_case_lookup: bool("us_uk_case_lookup"),
    export_detail: pick(EXPORT_DETAILS, value.export_detail, d.export_detail),
    parallel_files: typeof parallel === "number" && Number.isInteger(parallel) && parallel > 0 ? parallel : "auto",
    fn_filter: typeof value.fn_filter === "string" ? value.fn_filter : "",
  };
  // Local-only runs make no network or model calls (Python: LOCAL_ONLY forces free mode).
  if (settings.local_only) settings.run_mode = "free";
  return settings;
}

/** Footnote numbers from "1-5, 9, 12-14" (Python _parse_footnote_ids); null means every note. */
export function footnoteFilter(text: string): Set<number> | null {
  const ids = new Set<number>();
  for (const part of (text ?? "").split(",").map((item) => item.trim()).filter(Boolean)) {
    const [a, b] = part.includes("-") ? part.split(/-(.*)/su, 2).map((item) => Number(item.trim())) : [Number(part), Number(part)];
    if (!Number.isInteger(a) || !Number.isInteger(b)) continue;
    for (let id = Math.min(a, b); id <= Math.max(a, b); id++) ids.add(id);
  }
  return ids.size ? ids : null;
}
