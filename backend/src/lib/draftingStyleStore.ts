import path from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { isLocalRuntime } from "./localMode";
import { mikeLocalDataHome } from "./legalDataPath";
import { createServerSupabase } from "./supabase";
import {
  DEFAULT_DRAFTING_STYLE,
  normalizeDraftingStyleSettings,
  type DraftingStyleSettings,
} from "./draftingStyle";

const settingsPath = () => path.join(mikeLocalDataHome(), "drafting-style.json");
let localMutation: Promise<unknown> = Promise.resolve();

export async function getDraftingStyleSettings(
  userId: string,
  db?: ReturnType<typeof createServerSupabase>,
): Promise<DraftingStyleSettings> {
  if (isLocalRuntime()) {
    try { return normalizeDraftingStyleSettings(JSON.parse(await readFile(settingsPath(), "utf8"))); }
    catch { return DEFAULT_DRAFTING_STYLE; }
  }
  const client = db ?? createServerSupabase();
  const { data, error } = await client
    .from("user_profiles")
    .select("drafting_style")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
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
  if (isLocalRuntime()) {
    const operation = localMutation.then(async () => {
      const filename = settingsPath(), temporary = `${filename}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 });
        await rename(temporary, filename);
      } finally { await rm(temporary, { force: true }); }
      return settings;
    });
    localMutation = operation.catch(() => undefined);
    return operation;
  }
  const client = db ?? createServerSupabase();
  const { error } = await client
    .from("user_profiles")
    .update({ drafting_style: settings, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) throw error;
  return settings;
}
