export type Appearance = "system" | "light" | "dark";
const key = "beaver.appearance";
export function readAppearance(): Appearance {
  try {
    const value = localStorage.getItem(key);
    if (value === "light" || value === "dark") return value;
  } catch { /* Browser storage may be disabled. */ }
  return "system";
}
function apply(value: Appearance) {
  const dark = value === "dark" || value === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.appearance = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}
export function saveAppearance(value: Appearance) {
  try { localStorage.setItem(key, value); } catch { /* Keep the current tab usable. */ }
  apply(value);
}
export function initializeAppearance() {
  apply(readAppearance());
  const update = () => apply(readAppearance());
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", update);
  window.addEventListener("storage", (event) => { if (event.key === key || event.key === null) update(); });
}
