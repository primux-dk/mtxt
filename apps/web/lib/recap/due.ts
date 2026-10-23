/*
  Due dates from what a meeting said (packet 15). The draft's decisions
  often carry the deadline in words: "på torsdag", "i morgen", "inden
  fredag klokken tolv", "next week", "by the 30th". This turns such a
  phrase into a calendar date, worked out from the day the meeting was held
  on the install's time zone. It is the deterministic half of the lift; the
  prompt asks the model for a `~YYYY-MM-DD` too, and `decideDue` says which
  one stands.

  The rules, Danish and English alike:
  - today, tomorrow, the day after: the meeting's day plus 0, 1, 2;
  - a weekday ("torsdag", "on Thursday", "inden fredag"): the next one after
    the meeting's day, so "på torsdag" said on a Thursday is a week later;
    "<weekday> i næste uge" / "<weekday> next week" is that day of next week;
  - "næste uge" / "next week": the Friday of next week; "denne uge", "this
    week", "inden næste uge", "end of the week": the Friday of this week;
  - "den 30." / "the 30th": the next 30th on or after the meeting's day;
  - "30. oktober", "5 November", "October 5th": the next such day, or that
    year's when a year is given; "2026-10-30" and "30/10" as written;
  - "om en uge", "in two weeks", "om 3 dage": counted from the meeting's day;
  - "udgangen af måneden", "end of the month": the month's last day.

  A weekday after "fra", "efter", "sidste", "from", "since", "last" is a
  start or the past, not a deadline, and is skipped. "næste fredag" and
  "next Friday" mean this week's or next week's depending on who says it, so
  they, "næste måned", "next month", "snart" and "soon" make the item
  unsure. Two phrases that give different days make it unsure too. Unsure
  means no due date. A phrase that names a day before the meeting is a
  deadline that cannot be, and gives none either, the model's date
  included; a date before the meeting's day is never one.

  Pure: no clock, no database.
*/
import { dueDate } from './extensions';

/** The calendar day `at` falls on in `timeZone`, `YYYY-MM-DD`; UTC when the zone is unknown. */
export function meetingDay(at: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  try {
    return format(timeZone);
  } catch {
    return format('UTC');
  }
}

/** Whether `zone` is a time zone this runtime knows. */
let zones: Set<string> | null = null;
/**
 * Whether `zone` is one the settings page offers: UTC or a name in the
 * runtime's own list. `Intl` also takes offsets (`+01:00`) and legacy names
 * (`CET`); those are refused (packet 15 review).
 */
export function validTimeZone(zone: string): boolean {
  zones ??= new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
  return zones.has(zone);
}

const DAY_MS = 86_400_000;
const toDate = (day: string) => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
};
const iso = (date: Date) => date.toISOString().slice(0, 10);
const plus = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);
/** Monday is 0, Sunday 6. */
const weekdayOf = (date: Date) => (date.getUTCDay() + 6) % 7;
const lastOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0));

/** The date `y-m-d` when it exists (February 30 does not). */
function calendar(y: number, m: number, d: number): Date | null {
  const date = new Date(Date.UTC(y, m, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m && date.getUTCDate() === d
    ? date
    : null;
}

const WEEKDAYS: Record<string, number> = {
  mandag: 0,
  tirsdag: 1,
  onsdag: 2,
  torsdag: 3,
  fredag: 4,
  lørdag: 5,
  søndag: 6,
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};
const MONTHS: Record<string, number> = {
  januar: 0,
  january: 0,
  jan: 0,
  februar: 1,
  february: 1,
  feb: 1,
  marts: 2,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  maj: 4,
  may: 4,
  juni: 5,
  june: 5,
  jun: 5,
  juli: 6,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  oktober: 9,
  october: 9,
  okt: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};
const COUNTS: Record<string, number> = {
  en: 1,
  et: 1,
  a: 1,
  an: 1,
  one: 1,
  to: 2,
  two: 2,
  tre: 3,
  three: 3,
  fire: 4,
  four: 4,
  fem: 5,
  five: 5,
  seks: 6,
  six: 6,
  syv: 7,
  seven: 7,
  otte: 8,
  eight: 8,
  ni: 9,
  nine: 9,
  ti: 10,
  ten: 10,
  fjorten: 14,
  fourteen: 14,
};

const words = (list: Record<string, number>) =>
  Object.keys(list)
    .sort((a, b) => b.length - a.length)
    .join('|');
const WEEKDAY = words(WEEKDAYS);
const MONTH = words(MONTHS);
const COUNT = `\\d{1,2}|${words(COUNTS)}`;
/** Word edges that know æ, ø and å: `\b` does not. */
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';
const re = (source: string) => new RegExp(`${B}(?:${source})${E}`, 'giu');

type Rule = {
  pattern: RegExp;
  /** A date, `unsure`, or null when the match is not a deadline at all. */
  resolve: (m: RegExpExecArray, day: Date) => Date | 'unsure' | null;
};

/** The first day on or after `day` that is the `dom`th of a month, within a year. */
function nextDayOfMonth(day: Date, dom: number): Date | null {
  if (dom < 1 || dom > 31) return null;
  for (let i = 0; i < 13; i++) {
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + i;
    const date = calendar(y + Math.floor(m / 12), m % 12, dom);
    if (date && date >= day) return date;
  }
  return null;
}

/** `dom` of `month`: in `year` when given, else the next one on or after `day`. */
function dayOfMonth(day: Date, dom: number, month: number, year?: number): Date | null {
  if (year !== undefined) return calendar(year, month, dom);
  const y = day.getUTCFullYear();
  const date = calendar(y, month, dom);
  if (date && date >= day) return date;
  return calendar(y + 1, month, dom);
}

const fullYear = (text: string | undefined) => {
  if (!text) return undefined;
  const n = Number(text);
  return text.length === 2 ? 2000 + n : n;
};
const count = (text: string) => (/^\d+$/.test(text) ? Number(text) : COUNTS[text.toLowerCase()]!);
const fridayOf = (day: Date, weeks: number) => plus(day, 7 * weeks + 4 - weekdayOf(day));

/** In order: a longer phrase first, and each match's text is taken out before the next rule looks. */
const RULES: Rule[] = [
  // Vague on purpose: no date, whatever else the item says.
  {
    pattern: re(
      `(?:næste|next)\\s+(?:${WEEKDAY}|måned|month)|snart|soon|asap|hurtigst muligt|senere|later|inden længe`,
    ),
    resolve: () => 'unsure',
  },
  {
    pattern: re(`(\\d{4})-(\\d{2})-(\\d{2})`),
    resolve: (m) => {
      const value = dueDate(`${m[1]}-${m[2]}-${m[3]}`);
      return value ? toDate(value) : null;
    },
  },
  // 30/10 and 30/10/2026: day first unless that cannot be, and unsure when both read.
  {
    pattern: re(`(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?`),
    resolve: (m, day) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a <= 12 && b <= 12 && a !== b) return 'unsure';
      const [dom, month] = a > 12 ? [a, b] : b > 12 ? [b, a] : [a, b];
      return dayOfMonth(day, dom, month - 1, fullYear(m[3]));
    },
  },
  // "30. oktober", "den 30. okt. 2026", "5 November", "30th of October".
  {
    pattern: re(
      `(?:den\\s+|the\\s+)?(\\d{1,2})(?:\\.|st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})\\.?(?:,?\\s+(\\d{4}))?`,
    ),
    resolve: (m, day) =>
      dayOfMonth(day, Number(m[1]), MONTHS[m[2]!.toLowerCase()]!, fullYear(m[3])),
  },
  // "October 5th", "Oct 5, 2026".
  {
    pattern: re(`(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`),
    resolve: (m, day) =>
      dayOfMonth(day, Number(m[2]), MONTHS[m[1]!.toLowerCase()]!, fullYear(m[3])),
  },
  // "ultimo oktober", "end of October".
  {
    pattern: re(`(?:ultimo|end of|the end of)\\s+(${MONTH})`),
    resolve: (m, day) => {
      const month = MONTHS[m[1]!.toLowerCase()]!;
      const y = day.getUTCFullYear();
      const date = lastOfMonth(y, month);
      return date >= day ? date : lastOfMonth(y + 1, month);
    },
  },
  {
    pattern: re(
      `udgangen af (?:måneden|denne måned)|månedens udgang|ultimo måneden|(?:the )?end of (?:the|this) month`,
    ),
    resolve: (_, day) => lastOfMonth(day.getUTCFullYear(), day.getUTCMonth()),
  },
  // "den 30.", "the 30th", "by the 3rd".
  { pattern: re(`den\\s+(\\d{1,2})\\.`), resolve: (m, day) => nextDayOfMonth(day, Number(m[1])) },
  {
    pattern: re(`the\\s+(\\d{1,2})(?:st|nd|rd|th)`),
    resolve: (m, day) => nextDayOfMonth(day, Number(m[1])),
  },
  { pattern: re(`i overmorgen|the day after tomorrow`), resolve: (_, day) => plus(day, 2) },
  { pattern: re(`i morgen|tomorrow`), resolve: (_, day) => plus(day, 1) },
  { pattern: re(`i dag|today|tonight|end of (?:the )?day`), resolve: (_, day) => day },
  {
    pattern: re(`om\\s+(${COUNT})\\s+(dage?|uger?)|(?:in|within)\\s+(${COUNT})\\s+(days?|weeks?)`),
    resolve: (m, day) => {
      const n = count(m[1] ?? m[3]!);
      const unit = (m[2] ?? m[4]!).toLowerCase();
      return plus(day, unit.startsWith('d') ? n : n * 7);
    },
  },
  // "<weekday> i næste uge", "on Monday next week".
  {
    pattern: re(`(${WEEKDAY})\\s+(?:i\\s+)?(?:næste uge|next week)`),
    resolve: (m, day) => plus(day, 7 - weekdayOf(day) + WEEKDAYS[m[1]!.toLowerCase()]!),
  },
  {
    pattern: re(`(?:inden|før|before)\\s+(?:næste uge|next week)`),
    resolve: (_, day) => fridayOf(day, 0),
  },
  { pattern: re(`næste uge|next week`), resolve: (_, day) => fridayOf(day, 1) },
  {
    pattern: re(
      `(?:i\\s+)?denne uge|i løbet af ugen|inden weekenden|this week|(?:by\\s+)?(?:the\\s+)?end of the week|before the weekend`,
    ),
    resolve: (_, day) => fridayOf(day, 0),
  },
  // A weekday, with the word before it: "fra mandag" is a start, "sidste fredag" the past.
  {
    pattern: re(`(?:(\\p{L}+)\\s+)?(${WEEKDAY})`),
    resolve: (m, day) => {
      const before = m[1]?.toLowerCase();
      if (
        before &&
        ['fra', 'efter', 'siden', 'sidste', 'from', 'since', 'after', 'last', 'starting'].includes(
          before,
        )
      )
        return null;
      const ahead = (WEEKDAYS[m[2]!.toLowerCase()]! - weekdayOf(day) + 7) % 7 || 7;
      return plus(day, ahead);
    },
  },
];

export type Found =
  | { kind: 'date'; date: string }
  | { kind: 'none' }
  | { kind: 'unsure' }
  /** Every deadline it names is before the meeting: no date, and no model fallback. */
  | { kind: 'past' };

/** The due date a decision's text states, relative to the meeting's day (`YYYY-MM-DD`). */
export function findDue(text: string, day: string): Found {
  const start = toDate(day);
  let rest = text.replace(/\s+/g, ' ');
  const dates = new Set<string>();
  let unsure = false;
  let past = false;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    rest = rest.replace(rule.pattern, (...args) => {
      const match = Object.assign([...args.slice(0, -2)] as unknown as RegExpExecArray, {
        index: args.at(-2) as number,
        input: args.at(-1) as string,
      });
      const found = rule.resolve(match, start);
      if (found === 'unsure') unsure = true;
      else if (found && found >= start) dates.add(iso(found));
      else if (found) past = true;
      // Taken out, so "i overmorgen" is not read again as "i morgen".
      return ' '.repeat(match[0].length);
    });
  }
  if (unsure || dates.size > 1) return { kind: 'unsure' };
  const [date] = dates;
  return date ? { kind: 'date', date } : past ? { kind: 'past' } : { kind: 'none' };
}

/** The same day a year later; 29 February gives 28 February. */
function anniversary(day: Date): Date {
  const y = day.getUTCFullYear() + 1;
  const m = day.getUTCMonth();
  return calendar(y, m, day.getUTCDate()) ?? lastOfMonth(y, m);
}

/**
 * The due date a drafted decision keeps. A phrase in its text decides; an
 * unsure one, or one that names a day before the meeting, gives none. With
 * no phrase, the model's own `~date` stands when it is a real day from the
 * meeting's day to the same day a year later.
 */
export function decideDue(text: string, day: string, fromModel: string | null): string | null {
  const found = findDue(text, day);
  if (found.kind === 'date') return found.date;
  if (found.kind !== 'none') return null;
  const model = dueDate(fromModel);
  if (!model) return null;
  const at = toDate(model);
  const start = toDate(day);
  return at >= start && at <= anniversary(start) ? model : null;
}
