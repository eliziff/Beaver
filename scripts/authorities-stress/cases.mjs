// Every stress case, in the order the suite runs them.
import { FILE_CASES } from "./cases/files.mjs";
import { HIGHLIGHT_CASES } from "./cases/highlights.mjs";
import { IMPORT_CASES } from "./cases/imports.mjs";
import { PATH_CASES } from "./cases/paths.mjs";
import { PINPOINT_CASES } from "./cases/pinpoints.mjs";
import { SETTINGS_CASES } from "./cases/settings.mjs";
import { STRESS_CASES } from "./cases/stress.mjs";

export const CASES = [...IMPORT_CASES, ...PINPOINT_CASES, ...PATH_CASES, ...FILE_CASES, ...HIGHLIGHT_CASES, ...SETTINGS_CASES, ...STRESS_CASES];
