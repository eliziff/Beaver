import { modelForProvider, type PickerModel } from "./models";
import { canonicalKeyFor, nameKey } from "./modelsDev";
import type { Provider } from "./types";

// The picker is organized by model creator (company). Each catalogue entry is
// one (provider, native id) serving of a model; `modelKey` is the canonical
// identity that lets the UI present one row with a provider toggle.

const COMPANY_LABELS: Record<string, string> = {
    anthropic: "Anthropic", openai: "OpenAI", google: "Google", deepseek: "DeepSeek",
    meta: "Meta", xai: "xAI", alibaba: "Alibaba (Qwen)", qwen: "Alibaba (Qwen)",
    mistralai: "Mistral", mistral: "Mistral", moonshotai: "Moonshot (Kimi)",
    zhipuai: "Z.ai (GLM)", minimax: "MiniMax", bytedance: "ByteDance",
    tencent: "Tencent", meituan: "Meituan", inclusionai: "InclusionAI", nvidia: "NVIDIA",
    "z-ai": "Z.ai (GLM)", ollama: "Desktop",
};

// Most common companies first; the rest follow alphabetically.
const COMPANY_ORDER = [
    "Anthropic", "OpenAI", "Google", "xAI", "Meta", "DeepSeek",
    "Alibaba (Qwen)", "Mistral", "Moonshot (Kimi)", "Z.ai (GLM)", "MiniMax", "Desktop",
];
const DEFAULT_COMPANIES = new Set(COMPANY_ORDER);
// Subscription lanes first: when a model is reachable through a flat-rate
// subscription, that is the default serving, ahead of per-token API keys.
const PROVIDER_ORDER: Provider[] = [
    "codex", "claude-p", "opencode-go",
    "claude", "openai", "gemini", "deepseek", "meta",
    "openrouter", "ollama",
];
const PER_COMPANY_LIMIT = 14;
// Batch endpoints are asynchronous and not for interactive work; dated slugs
// are snapshots of a model already present; and models older than the window
// are no longer apt for this product.
const DATED_SUFFIX = /(?:^|[-.])\d{4,8}$/u;
const MAX_AGE_DAYS = Number(process.env.MIKE_MODEL_MAX_AGE_DAYS) || 400;
// Asynchronous endpoints, duplicate free variants, and open-weight or
// safety-only models that this product does not drive.
const EXCLUDED = /gpt-oss|gemma|voxtral|computer-use|safeguard|nano-banana|imagen|dall-e|gpt-image|image/u;
// Superseded majors this product no longer offers.
const RETIRED = /deepseek-v3|deepseek-chat-v3|glm-4|minimax-m1|minimax-m2($|[.\-/])|llama-\d|muse-spark-1\.1|grok-4\.3|mistral-medium-3\.1|kimi-k2-thinking/u;
const isExcluded = (id: string) =>
    id.includes(":batch") || id.includes(":free") || EXCLUDED.test(id) || RETIRED.test(id);
const versionScore = (text: string): number => {
    const match = /(\d+)(?:\.(\d+))?/u.exec(text);
    return match ? Number(match[1]) * 1_000_000 + (match[2] ? Number(match[2]) * 1_000 : 0) : -1;
};

function companyLabel(creator: string): string {
    return COMPANY_LABELS[creator] ?? creator.split(/[-_]/u).filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function allowedCompanies(): Set<string> {
    const configured = process.env.MIKE_MODEL_COMPANIES?.trim();
    if (!configured) return DEFAULT_COMPANIES;
    if (configured.toLowerCase() === "all") return new Set();
    return new Set(configured.split(",").map((name) => name.trim()).filter(Boolean));
}

// Tier names come from the first-party catalogue, not an aggregator's vendor label.
const DIRECT_PROVIDERS = new Set<Provider>(["claude", "openai", "gemini", "deepseek", "meta"]);

const providerRank = (provider: Provider) => {
    const index = PROVIDER_ORDER.indexOf(provider);
    return index === -1 ? PROVIDER_ORDER.length : index;
};

function companyRank(company: string): number {
    const index = COMPANY_ORDER.indexOf(company);
    return index === -1 ? COMPANY_ORDER.length : index;
}

/** Groups concrete provider entries into one row per model, ordered by commonness. */
export function buildCreatorCatalog(options: PickerModel[]): PickerModel[] {
    const relevant = options.filter((option) =>
        !isExcluded(option.id) && !DATED_SUFFIX.test(modelForProvider(option.id)));
    const byCanonical = new Map<string, { company: string; entries: PickerModel[] }>();
    for (const option of [...relevant].sort((left, right) => providerRank(left.provider) - providerRank(right.provider))) {
        const key = canonicalKeyFor(option.provider, modelForProvider(option.id));
        const row = byCanonical.get(key) ?? { company: companyLabel(key.split("/")[0]), entries: [] };
        row.entries.push({ ...option, modelKey: key });
        byCanonical.set(key, row);
    }
    // Providers spell the same model differently (`claude-fable-5-1` vs
    // `claude-fable-5.1`); collapse rows that share a normalized label.
    const rows = new Map<string, { company: string; entries: PickerModel[] }>();
    for (const row of byCanonical.values()) {
        const key = nameKey(row.entries[0].label);
        const existing = rows.get(key);
        if (existing) { existing.entries.push(...row.entries); continue; }
        rows.set(key, { company: row.company, entries: [...row.entries] });
    }
    for (const row of rows.values()) {
        row.entries.sort((left, right) => providerRank(left.provider) - providerRank(right.provider));
        // The direct provider's tier names the whole row, whatever a
        // subscription or aggregator family label happened to be.
        const tier = (row.entries.find((entry) => DIRECT_PROVIDERS.has(entry.provider) && entry.family)
            ?? row.entries.find((entry) => entry.family))?.family;
        const canonical = row.entries.find((entry) => DIRECT_PROVIDERS.has(entry.provider))?.modelKey
            ?? row.entries[0].modelKey;
        row.entries = row.entries.map((entry) => ({ ...entry, modelKey: canonical,
            ...(tier ? { family: tier } : {}) }));
    }

    const cutoff = Date.now() - MAX_AGE_DAYS * 86_400_000;
    const allow = allowedCompanies();
    const visible = [...rows.values()].filter((row) => {
        if (allow.size && !allow.has(row.company) && row.company !== "Desktop") return false;
        // Prefer the first-party release date; a row with no date is kept, a
        // known-old row is dropped.
        const direct = row.entries.find((entry) => DIRECT_PROVIDERS.has(entry.provider) && entry.releasedAt)?.releasedAt;
        const release = direct ?? Math.max(0, ...row.entries.map((entry) => entry.releasedAt ?? 0));
        return release === 0 || release >= cutoff;
    });
    const companies = [...new Set(visible.map((row) => row.company))]
        .sort((left, right) => companyRank(left) - companyRank(right) || left.localeCompare(right));

    const output: PickerModel[] = [];
    for (const company of companies) {
        const companyRows = visible.filter((row) => row.company === company)
            .sort((left, right) =>
                versionScore(right.entries[0].label) - versionScore(left.entries[0].label) ||
                left.entries[0].label.localeCompare(right.entries[0].label))
            .slice(0, PER_COMPANY_LIMIT);
        for (const row of companyRows) {
            for (const entry of row.entries) output.push({ ...entry, group: company });
        }
    }
    return output;
}
