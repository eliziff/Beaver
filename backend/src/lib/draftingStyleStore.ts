import path from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { isAnonymousLocalMode } from "./localMode";
import { mikeLocalDataHome } from "./legalDataPath";
import { createServerSupabase } from "./supabase";
import {
  DEFAULT_DRAFTING_STYLE,
  normalizeDraftingStyleSettings,
  type DraftingStyleSettings,
} from "./draftingStyle";

const localPath = () => path.join(mikeLocalDataHome(), "drafting-style.json");
let localMutation: Promise<unknown> = Promise.resolve();

async function readLocalDraftingStyle() {
  try {
    return normalizeDraftingStyleSettings(
      JSON.parse(await readFile(localPath(), "utf8")),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return DEFAULT_DRAFTING_STYLE;
    }
    return DEFAULT_DRAFTING_STYLE;
  }
}

async function writeLocalDraftingStyle(settings: DraftingStyleSettings) {
  const filename = localPath();
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temporary, filename);
}

export const getLocalDraftingStyleSettings = readLocalDraftingStyle;

export async function saveLocalDraftingStyleSettings(value: unknown) {
  const settings = normalizeDraftingStyleSettings(value);
  const operation = localMutation.then(() => writeLocalDraftingStyle(settings));
  localMutation = operation.catch(() => undefined);
  await operation;
  return settings;
}

export async function getDraftingStyleSettings(
  userId: string,
  db?: ReturnType<typeof createServerSupabase>,
): Promise<DraftingStyleSettings> {
  if (isAnonymousLocalMode()) return readLocalDraftingStyle();
  const client = db ?? createServerSupabase();
  const { data } = await client
    .from("user_profiles")
    .select("drafting_style")
    .eq("user_id", userId)
    .maybeSingle();
  return normalizeDraftingStyleSettings(
    (data as { drafting_style?: unknown } | null)?.drafting_style,
  );
}

export async function saveDraftingStyleSettings(
  userId: string,
  value: unknown,
  db?: ReturnType<typeof createServerSupabase>,
): Promise<DraftingStyleSettings> {
  const settings = normalizeDraftingStyleSettings(value);
  if (isAnonymousLocalMode()) {
    return saveLocalDraftingStyleSettings(settings);
  }
  const client = db ?? createServerSupabase();
  const { error } = await client
    .from("user_profiles")
    .update({ drafting_style: settings, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw error;
  return settings;
}
