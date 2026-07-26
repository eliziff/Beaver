import os from "node:os";
import path from "node:path";

type Environment = Record<string, string | undefined>;

/**
 * Shared provider databases and caches live outside any one application.
 * App-specific documents, projects, preferences, and outputs do not.
 */
export function legalDataHome(options?: {
  env?: Environment;
  platform?: NodeJS.Platform;
  home?: string;
}) {
  const env = options?.env ?? process.env;
  const configured =
    env.OPEN_LEGAL_DATA_HOME?.trim() || env.MIKE_LOCAL_DATA_DIR?.trim();
  if (configured) return path.resolve(configured);

  const platform = options?.platform ?? process.platform;
  const home = options?.home ?? os.homedir();
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local");
    return path.resolve(localAppData, "OpenLegalProducts", "LegalData");
  }
  if (platform === "darwin") {
    return path.resolve(
      home,
      "Library",
      "Application Support",
      "OpenLegalProducts",
      "LegalData",
    );
  }
  const dataHome =
    env.XDG_DATA_HOME?.trim() || path.join(home, ".local", "share");
  return path.resolve(dataHome, "OpenLegalProducts", "LegalData");
}

export function legalProviderDatabase(provider: string, filename: string) {
  return path.join(legalDataHome(), "providers", provider, filename);
}
