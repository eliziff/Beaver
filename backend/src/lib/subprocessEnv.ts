const SYSTEM_ENV = new Set([
  "APPDATA", "COMSPEC", "HOME", "LANG", "LC_ALL", "LOCALAPPDATA", "PATH",
  "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)", "SHELL", "SYSTEMROOT",
  "TEMP", "TMP", "TMPDIR", "USERPROFILE", "WINDIR", "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME",
]);

/** Keep server credentials out of document parsers and provider subprocesses. */
export function isolatedProcessEnv(allow: readonly string[] = []) {
  const exact = new Set(allow.filter((name) => !name.endsWith("*"))
    .map((name) => name.toUpperCase()));
  const prefixes = allow.filter((name) => name.endsWith("*"))
    .map((name) => name.slice(0, -1).toUpperCase());
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => {
    const upper = name.toUpperCase();
    return SYSTEM_ENV.has(upper) || exact.has(upper) ||
      prefixes.some((prefix) => upper.startsWith(prefix));
  }));
}
