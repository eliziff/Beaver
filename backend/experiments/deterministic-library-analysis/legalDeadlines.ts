/**
 * Deterministic deadline arithmetic for legal time computation.
 *
 * LLMs are measurably bad at calendar math (Test of Time, PRIMETIME), and
 * limitation periods are where the malpractice risk lives — exactly where
 * determinism belongs. This engine encodes the computation-of-time rules
 * once and returns a DERIVATION TRACE with every result (the rules-as-code
 * lesson: for lawyers the explanation is the product, not just the date).
 *
 * Rules implemented (Interpretation Act, R.S.C. 1985, c. I-21):
 *   s. 26     deadline falling on a holiday rolls to the next non-holiday
 *   s. 27(1)  "clear days" / "at least N days": both terminal days excluded
 *   s. 27(2)  plain "N days between/after": first day excluded, last included
 *   s. 28     months: anniversary day, clamped to month end
 * plus business-day counting (weekends + jurisdiction holidays skipped) and
 * contract-defined extra non-business days.
 *
 * Holiday tables are COMPUTED from the statutory formulas (Easter computus,
 * nth-weekday rules), never hardcoded per year.
 */

export type DeadlineJurisdiction = "CA" | "CA-ON" | "CA-BC" | "CA-QC" | "US";

export type DeadlineUnit =
  | "day"
  | "business_day"
  | "clear_day"
  | "week"
  | "month"
  | "year";

export interface DeadlineOptions {
  /** ISO date the period runs from (or to, when direction is "before"). */
  anchor: string;
  count: number;
  unit: DeadlineUnit;
  direction?: "after" | "before";
  jurisdiction?: DeadlineJurisdiction;
  /**
   * Roll a day/week/month/year deadline off holidays and weekends
   * (Interpretation Act s. 26). Defaults on. Weekends roll only when
   * `weekend` treats them as non-working.
   */
  rollover?: boolean;
  /**
   * Which weekend days are non-working for rollover/business counting.
   * Federal s. 35 "holiday" includes Sunday but NOT Saturday; court rules
   * and commercial Business Day definitions treat both as non-working.
   */
  weekend?: "sat_sun" | "sun_only";
  /** Contract-defined additional non-business days (ISO dates). */
  extraHolidays?: string[];
}

export interface DeadlineTraceStep {
  rule: string;
  note: string;
  date?: string;
}

export interface DeadlineResult {
  date: string;
  weekday: string;
  trace: DeadlineTraceStep[];
}

/* ------------------------------------------------------------------ */
/* Date plumbing — epoch-day integers, no timezones anywhere            */
/* ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parseISO(iso: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso.trim());
  if (!match) throw new Error(`not an ISO date: ${iso}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS;
}

function toISO(days: number): string {
  const date = new Date(days * DAY_MS);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const weekdayOf = (days: number) => ((days % 7) + 7 + 4) % 7; // 1970-01-01 = Thu

function ymd(days: number): { y: number; m: number; d: number } {
  const date = new Date(days * DAY_MS);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

const fromYMD = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY_MS;

const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Anonymous Gregorian computus. */
function easterSunday(year: number): { m: number; d: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { m: month, d: day };
}

/** nth (1-based) weekday-of-month; weekday 0 = Sunday. */
function nthWeekday(y: number, m: number, weekday: number, n: number): number {
  const first = fromYMD(y, m, 1);
  const offset = (weekday - weekdayOf(first) + 7) % 7;
  return first + offset + 7 * (n - 1);
}

/** The <weekday> strictly before the given date (Victoria Day rule). */
function weekdayBefore(y: number, m: number, d: number, weekday: number): number {
  let day = fromYMD(y, m, d) - 1;
  while (weekdayOf(day) !== weekday) day -= 1;
  return day;
}

/* ------------------------------------------------------------------ */
/* Holiday tables — statutory formulas, computed per year               */
/* ------------------------------------------------------------------ */

type HolidayRule = (year: number) => Array<[number, string]>;

const easterPair: HolidayRule = (y) => {
  const easter = easterSunday(y);
  const sunday = fromYMD(y, easter.m, easter.d);
  return [
    [sunday - 2, "Good Friday"],
    [sunday + 1, "Easter Monday"],
  ];
};

const CA_FEDERAL: HolidayRule = (y) => [
  [fromYMD(y, 1, 1), "New Year's Day"],
  ...easterPair(y),
  [weekdayBefore(y, 5, 25, 1), "Victoria Day"],
  [fromYMD(y, 7, 1), "Canada Day"],
  [nthWeekday(y, 9, 1, 1), "Labour Day"],
  ...(y >= 2021 ? ([[fromYMD(y, 9, 30), "National Day for Truth and Reconciliation"]] as Array<[number, string]>) : []),
  [nthWeekday(y, 10, 1, 2), "Thanksgiving"],
  [fromYMD(y, 11, 11), "Remembrance Day"],
  [fromYMD(y, 12, 25), "Christmas Day"],
  [fromYMD(y, 12, 26), "Boxing Day"],
];

const CA_ON: HolidayRule = (y) => [
  [fromYMD(y, 1, 1), "New Year's Day"],
  ...(y >= 2008 ? ([[nthWeekday(y, 2, 1, 3), "Family Day"]] as Array<[number, string]>) : []),
  ...easterPair(y),
  [weekdayBefore(y, 5, 25, 1), "Victoria Day"],
  [fromYMD(y, 7, 1), "Canada Day"],
  [nthWeekday(y, 9, 1, 1), "Labour Day"],
  [nthWeekday(y, 10, 1, 2), "Thanksgiving"],
  [fromYMD(y, 12, 25), "Christmas Day"],
  [fromYMD(y, 12, 26), "Boxing Day"],
];

const CA_BC: HolidayRule = (y) => [
  [fromYMD(y, 1, 1), "New Year's Day"],
  ...(y >= 2013 ? ([[nthWeekday(y, 2, 1, 3), "Family Day"]] as Array<[number, string]>) : []),
  ...easterPair(y).slice(0, 1), // Easter Monday is not a BC statutory holiday
  [weekdayBefore(y, 5, 25, 1), "Victoria Day"],
  [fromYMD(y, 7, 1), "Canada Day"],
  [nthWeekday(y, 8, 1, 1), "British Columbia Day"],
  [nthWeekday(y, 9, 1, 1), "Labour Day"],
  ...(y >= 2023 ? ([[fromYMD(y, 9, 30), "National Day for Truth and Reconciliation"]] as Array<[number, string]>) : []),
  [nthWeekday(y, 10, 1, 2), "Thanksgiving"],
  [fromYMD(y, 11, 11), "Remembrance Day"],
  [fromYMD(y, 12, 25), "Christmas Day"],
];

const CA_QC: HolidayRule = (y) => [
  [fromYMD(y, 1, 1), "New Year's Day"],
  ...easterPair(y),
  [weekdayBefore(y, 5, 25, 1), "National Patriots' Day"],
  [fromYMD(y, 6, 24), "Fête nationale (Saint-Jean-Baptiste)"],
  [fromYMD(y, 7, 1), "Canada Day"],
  [nthWeekday(y, 9, 1, 1), "Labour Day"],
  [nthWeekday(y, 10, 1, 2), "Thanksgiving"],
  [fromYMD(y, 12, 25), "Christmas Day"],
];

/** US federal, with the observed-day shift (Sat→Fri, Sun→Mon). */
const US_FEDERAL: HolidayRule = (y) => {
  const fixed: Array<[number, string]> = [
    [fromYMD(y, 1, 1), "New Year's Day"],
    [fromYMD(y, 6, 19), "Juneteenth"],
    [fromYMD(y, 7, 4), "Independence Day"],
    [fromYMD(y, 11, 11), "Veterans Day"],
    [fromYMD(y, 12, 25), "Christmas Day"],
  ].filter(([, name]) => name !== "Juneteenth" || y >= 2021) as Array<[number, string]>;
  const observed = fixed.flatMap(([day, name]): Array<[number, string]> => {
    const dow = weekdayOf(day);
    if (dow === 6) return [[day, name], [day - 1, `${name} (observed)`]];
    if (dow === 0) return [[day, name], [day + 1, `${name} (observed)`]];
    return [[day, name]];
  });
  return [
    ...observed,
    [nthWeekday(y, 1, 1, 3), "Birthday of Martin Luther King, Jr."],
    [nthWeekday(y, 2, 1, 3), "Washington's Birthday"],
    [nthWeekday(y, 9, 1, 1), "Labor Day"],
    [nthWeekday(y, 10, 1, 2), "Columbus Day"],
    [nthWeekday(y, 11, 4, 4), "Thanksgiving"],
  ];
};

/** Last Monday of May (US Memorial Day). */
function lastMonday(y: number, m: number): number {
  const last = fromYMD(y, m, daysInMonth(y, m));
  return last - ((weekdayOf(last) - 1 + 7) % 7);
}

const RULES: Record<DeadlineJurisdiction, HolidayRule> = {
  CA: CA_FEDERAL,
  "CA-ON": CA_ON,
  "CA-BC": CA_BC,
  "CA-QC": CA_QC,
  US: (y) => [...US_FEDERAL(y), [lastMonday(y, 5), "Memorial Day"]],
};

export function holidaysFor(
  year: number,
  jurisdiction: DeadlineJurisdiction,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [day, name] of RULES[jurisdiction](year)) {
    map.set(toISO(day), name);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

interface Calendar {
  holidayName: (day: number) => string | undefined;
  isWorking: (day: number) => boolean;
}

function buildCalendar(opts: DeadlineOptions): Calendar {
  const jurisdiction = opts.jurisdiction ?? "CA";
  const weekend = opts.weekend ?? "sat_sun";
  const extra = new Set(opts.extraHolidays ?? []);
  const cache = new Map<number, Map<string, string>>();
  const holidayName = (day: number): string | undefined => {
    const { y } = ymd(day);
    if (!cache.has(y)) cache.set(y, holidaysFor(y, jurisdiction));
    const iso = toISO(day);
    return cache.get(y)?.get(iso) ?? (extra.has(iso) ? "contract-designated non-business day" : undefined);
  };
  const isWorking = (day: number): boolean => {
    const dow = weekdayOf(day);
    if (dow === 0) return false;
    if (dow === 6 && weekend === "sat_sun") return false;
    return holidayName(day) === undefined;
  };
  return { holidayName, isWorking };
}

function describe(day: number): string {
  return `${toISO(day)} (${WEEKDAYS[weekdayOf(day)]})`;
}

/**
 * Compute a deadline with a full derivation trace. Deterministic; throws
 * only on malformed input, never guesses.
 */
export function computeDeadline(opts: DeadlineOptions): DeadlineResult {
  if (!Number.isInteger(opts.count) || opts.count <= 0) {
    throw new Error(`count must be a positive integer, got ${opts.count}`);
  }
  const anchor = parseISO(opts.anchor);
  const direction = opts.direction ?? "after";
  const sign = direction === "after" ? 1 : -1;
  const calendar = buildCalendar(opts);
  const trace: DeadlineTraceStep[] = [];
  const jurisdiction = opts.jurisdiction ?? "CA";
  trace.push({
    rule: "anchor",
    note: `period of ${opts.count} ${opts.unit.replace("_", " ")}${opts.count === 1 ? "" : "s"} ${direction} ${describe(anchor)} [${jurisdiction}]`,
    date: toISO(anchor),
  });

  let result: number;
  switch (opts.unit) {
    case "day": {
      result = anchor + sign * opts.count;
      trace.push({
        rule: "Interpretation Act s. 27(2)",
        note: `anchor day excluded, last day included → ${describe(result)}`,
        date: toISO(result),
      });
      break;
    }
    case "clear_day": {
      result = anchor + sign * (opts.count + 1);
      trace.push({
        rule: "Interpretation Act s. 27(1)",
        note: `"clear days"/"at least": both terminal days excluded → ${describe(result)}`,
        date: toISO(result),
      });
      break;
    }
    case "week": {
      result = anchor + sign * 7 * opts.count;
      trace.push({
        rule: "weeks",
        note: `${opts.count} × 7 days → ${describe(result)}`,
        date: toISO(result),
      });
      break;
    }
    case "month":
    case "year": {
      const { y, m, d } = ymd(anchor);
      const months = opts.unit === "year" ? 12 * opts.count : opts.count;
      const total = m - 1 + sign * months;
      const targetYear = y + Math.floor(total / 12);
      const targetMonth = (total % 12 + 12) % 12 + 1;
      const clamped = Math.min(d, daysInMonth(targetYear, targetMonth));
      result = fromYMD(targetYear, targetMonth, clamped);
      trace.push({
        rule: "Interpretation Act s. 28",
        note:
          clamped === d
            ? `anniversary day in the target month → ${describe(result)}`
            : `target month has no day ${d}; clamped to month end → ${describe(result)}`,
        date: toISO(result),
      });
      break;
    }
    case "business_day": {
      result = anchor;
      let counted = 0;
      while (counted < opts.count) {
        result += sign;
        if (calendar.isWorking(result)) {
          counted += 1;
        } else {
          const name = calendar.holidayName(result);
          trace.push({
            rule: "business-day counting",
            note: `${describe(result)} skipped (${name ?? "weekend"})`,
          });
        }
      }
      trace.push({
        rule: "business-day counting",
        note: `${opts.count}th business day ${direction} anchor → ${describe(result)}`,
        date: toISO(result),
      });
      break;
    }
    default:
      throw new Error(`unknown unit: ${opts.unit as string}`);
  }

  const rollover = opts.rollover ?? opts.unit !== "business_day";
  if (rollover && opts.unit !== "business_day") {
    while (!calendar.isWorking(result)) {
      const name = calendar.holidayName(result) ?? "weekend";
      const next = result + (direction === "before" ? -1 : 1);
      trace.push({
        rule: "Interpretation Act s. 26",
        note: `${describe(result)} is ${name}; deadline moves to ${describe(next)}`,
        date: toISO(next),
      });
      result = next;
    }
  }

  return { date: toISO(result), weekday: WEEKDAYS[weekdayOf(result)], trace };
}

/**
 * Bridge from the anchor extractor's duration norms ("dur:5:business_day")
 * to engine parameters.
 */
export function durationNormToUnit(
  norm: string,
): { count: number; unit: DeadlineUnit } | null {
  const match = /^dur:(\d+):([a-z_]+)$/u.exec(norm);
  if (!match) return null;
  const count = Number(match[1]);
  const raw = match[2];
  const unit: DeadlineUnit | null =
    raw === "business_day"
      ? "business_day"
      : raw === "day"
        ? "day"
        : raw === "week"
          ? "week"
          : raw === "month"
            ? "month"
            : raw === "year"
              ? "year"
              : null;
  return unit ? { count, unit } : null;
}

export function isBusinessDay(
  iso: string,
  opts: Pick<DeadlineOptions, "jurisdiction" | "weekend" | "extraHolidays">,
): boolean {
  return buildCalendar({ anchor: iso, count: 1, unit: "day", ...opts }).isWorking(parseISO(iso));
}
