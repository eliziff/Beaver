import {
  decodeJson, encodeJson, relationalDatabase, sql, type RelationalDatabase,
} from "./relationalDatabase";
import {
  DEFAULT_DRAFTING_STYLE, normalizeDraftingStyleSettings, type DraftingStyleSettings,
} from "./draftingStyle";

export async function getDraftingStyleSettings(userId: string, database?: RelationalDatabase):
  Promise<DraftingStyleSettings> {
  const db = database ?? await relationalDatabase();
  const row = (await db.query<{ drafting_style: unknown }>(sql`
    SELECT drafting_style FROM user_preferences WHERE user_id=${userId}`)).rows[0];
  return row ? normalizeDraftingStyleSettings(decodeJson(row.drafting_style, null))
    : DEFAULT_DRAFTING_STYLE;
}

export async function saveDraftingStyleSettings(userId: string, value: unknown,
  database?: RelationalDatabase): Promise<DraftingStyleSettings> {
  const settings = normalizeDraftingStyleSettings(value), db = database ?? await relationalDatabase();
  await db.query(sql`INSERT INTO user_preferences(user_id,drafting_style,updated_at)
    VALUES(${userId},${encodeJson(settings)},${new Date().toISOString()})
    ON CONFLICT(user_id) DO UPDATE SET drafting_style=excluded.drafting_style,
      updated_at=excluded.updated_at`);
  return settings;
}
