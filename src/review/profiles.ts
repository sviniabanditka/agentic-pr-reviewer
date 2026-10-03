import type { Database } from "bun:sqlite";
import { DEFAULT_PROFILES, resolveProfile, type ProfileOptions, type ResolvedProfile } from "./modes.js";
import { insertProfile, listProfiles, type ProfileRow } from "../store/repos.js";

/** Every user starts with the built-in profiles; created on first need. */
export function ensureProfiles(db: Database, userId: string): ProfileRow[] {
  const existing = listProfiles(db, userId);
  if (existing.length > 0) return existing;
  for (const p of DEFAULT_PROFILES) insertProfile(db, { user_id: userId, name: p.name, mode: p.mode, options: p.options, is_default: p.isDefault ?? false });
  return listProfiles(db, userId);
}

export function defaultProfile(db: Database, userId: string): ProfileRow {
  const all = ensureProfiles(db, userId);
  return all.find((p) => p.is_default) ?? all[0]!;
}

export function resolveRow(p: Pick<ProfileRow, "mode" | "options_json">): ResolvedProfile {
  return resolveProfile(p.mode, JSON.parse(p.options_json) as ProfileOptions);
}
