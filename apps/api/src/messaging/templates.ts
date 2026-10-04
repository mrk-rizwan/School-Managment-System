// Message templates (contracts/slice-9.md §7.5; contracts/slice-10.md §4.7, §6): English only
// (rule 16), one per type, in code. Every SMS-eligible body starts with the school's name (cut to
// 30 characters at a word boundary) because the sender mask does not show on Telenor or Ufone.
// Bodies never hold an identity number, a token, a password, a phone number or an amount with
// paisa (R111); SMS text is normalised to GSM-7 and each templated body fits one segment with the
// longest fixture values (R110, templates.spec.ts).
import type { DayStatus, MessageSubjectType, MessageType, WhatsAppErrorCode } from '@asms/shared';
import type { TemplateVarsMap } from './types';

export interface Rendered {
  /** Push title and email subject. */
  title: string;
  /** WhatsApp, SMS, push and email body; stored on the message. */
  body: string;
}

export interface RenderContext {
  schoolName: string;
  timezone: string;
  subjectType: MessageSubjectType;
}

// ---------------------------------------------------------------------------------- GSM-7

const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€';
const GSM = new Set([...GSM_BASIC, ...GSM_EXTENDED]);
const EXTENDED = new Set([...GSM_EXTENDED]);

const NEAREST: Readonly<Record<string, string>> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '–': '-',
  '—': '-',
  '−': '-',
  '…': '...',
  ' ': ' ',
  ' ': ' ',
  '​': '',
  '\t': ' ',
};

/** Every character GSM-7 can carry; others replaced by their nearest ASCII or dropped. */
export function toGsm7(text: string): string {
  let out = '';
  for (const char of text) {
    if (GSM.has(char)) {
      out += char;
      continue;
    }
    const near = NEAREST[char];
    if (near !== undefined) {
      out += near;
      continue;
    }
    // Strip accents (e.g. "ā" -> "a") and keep what survives.
    const base = char.normalize('NFD').replace(/\p{M}/gu, '');
    out += [...base].filter((c) => GSM.has(c)).join('');
  }
  return out;
}

/** Septets used: the extension table's characters take two. */
export const gsmLength = (text: string): number =>
  [...text].reduce((n, c) => n + (EXTENDED.has(c) ? 2 : 1), 0);

/** SMS segments of GSM-7 text: 160 in one, 153 per part when concatenated. */
export function smsSegments(text: string): number {
  const length = gsmLength(text);
  return length <= 160 ? 1 : Math.ceil(length / 153);
}

// ------------------------------------------------------------------------------ formatting

export const SCHOOL_NAME_MAX = 30;

/** The school's name cut to 30 characters at a word boundary (§7.5). */
export function schoolLabel(name: string): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (clean.length <= SCHOOL_NAME_MAX) return clean;
  const cut = clean.slice(0, SCHOOL_NAME_MAX + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : clean.slice(0, SCHOOL_NAME_MAX)).trim();
}

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });

/** A calendar date (a DATE value, midnight UTC) as `Mon 6 Oct`. */
export const formatDay = (date: Date): string =>
  `${DAY.format(date)} ${date.getUTCDate()} ${MONTH.format(date)}`;

/** An instant as `HH:MM` in the school's time zone. */
export const formatTime = (instant: Date, timezone: string): string =>
  new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(instant);

const sameDay = (a: Date, b: Date): boolean => a.getTime() === b.getTime();
const range = (from: Date, to: Date): string =>
  sameDay(from, to) ? formatDay(from) : `${formatDay(from)} to ${formatDay(to)}`;

/** `text` cut with `...` so that `build(text)` fits one SMS segment. */
function fitOneSegment(text: string, build: (fitted: string) => string): string {
  if (smsSegments(toGsm7(build(text))) === 1) return build(text);
  let fitted = text;
  while (fitted.length > 1) {
    fitted = fitted.slice(0, -1).trimEnd();
    const candidate = build(`${fitted}...`);
    if (smsSegments(toGsm7(candidate)) === 1) return candidate;
  }
  return build('...');
}

/** Template fixture limits (contracts/slice-11.md §6.5). */
const STUDENT_NAME_MAX = 40;
const CLASS_SECTION_MAX = 16;
const UNRECORDED_NAMED = 5;

/** `text` cut to `max` characters at a word boundary, marked with `...`. */
export function cutWords(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const room = clean.slice(0, max - 3);
  const space = room.lastIndexOf(' ');
  return `${(space > 0 ? room.slice(0, space) : room).trimEnd()}...`;
}

/** `{class} {section}`, cut to 16 characters. */
const classSection = (vars: { className: string; sectionName: string }): string =>
  cutWords(`${vars.className} ${vars.sectionName}`, CLASS_SECTION_MAX);

/** A derived day status as a parent reads it: "partial" is a screen word (§6.5). */
function dayWords(status: DayStatus, arrivedAt: string | null): string {
  switch (status) {
    case 'present':
      return 'present';
    case 'late':
      return arrivedAt === null ? 'late' : `late (arrived ${arrivedAt})`;
    case 'partial':
      return 'partly absent';
    case 'on_leave':
      return 'on leave';
    case 'absent':
      return 'absent';
  }
}

// ------------------------------------------------------------------------------ templates

/** Each type's body; its title comes from titleOf, the one table of titles. */
type Renderers = {
  [K in MessageType]: (vars: TemplateVarsMap[K], ctx: RenderContext) => string;
};

const notWritten = (type: MessageType) => (): string => {
  throw new Error(`the ${type} template is written by its own slice`);
};

const RENDERERS: Renderers = {
  announcement_urgent: notWritten('announcement_urgent'),
  announcement_normal: notWritten('announcement_normal'),
  whatsapp_session_down: notWritten('whatsapp_session_down'),

  messaging_test: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: test message from ASMS, sent by ${vars.senderName} at ${formatTime(vars.time, ctx.timezone)}. No action needed.`,

  sms_cap_reached: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)} has used this month's ${vars.cap} SMS units. Further SMS are held until ${formatDay(vars.nextMonthStart)} or until the platform raises the allowance.`,

  // contracts/slice-10.md §4.7: the notice, or (subject holiday_cancellation) its cancellation.
  holiday_notice: (vars, ctx) => {
    const school = schoolLabel(ctx.schoolName);
    const when = range(vars.startsOn, vars.endsOn);
    if (ctx.subjectType === 'holiday_cancellation') {
      return fitOneSegment(
        vars.name,
        (name) => `${school}: The holiday on ${when} (${name}) is cancelled. School is open as normal.`,
      );
    }
    const reopens =
      vars.reopensOn === undefined || vars.reopensOn === null
        ? ''
        : ` Reopens ${formatDay(vars.reopensOn)}.`;
    return fitOneSegment(vars.name, (name) => `${school}: School closed ${when} for ${name}.${reopens}`);
  },

  // contracts/slice-13.md §4.6 (R138): low priority, never SMS; names neither the author nor a
  // student. `topic` already refuses identity and phone patterns.
  diary_posted: (vars, ctx) => {
    const due = vars.dueOn === null ? '' : `. Due ${formatDay(vars.dueOn)}`;
    return `${schoolLabel(ctx.schoolName)}: ${vars.className} ${vars.sectionName} ${vars.subjectName} diary for ${formatDay(vars.date)}: ${vars.topic}${due}`;
  },

  // contracts/slice-13.md §5.4 (R140): the remark text never enters a message.
  remark_posted: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: A new ${vars.category} remark for ${vars.studentName} dated ${formatDay(vars.date)}. Open the app to read it.`,

  // contracts/slice-11.md §6.5 (R126): one segment with the longest fixture values (school 30,
  // student 40, class and section 16); longer names are cut at a word boundary.
  absence_alert: (vars, ctx) =>
    fitOneSegment(
      cutWords(vars.studentName, STUDENT_NAME_MAX),
      (name) =>
        `${schoolLabel(ctx.schoolName)}: ${name} (${classSection(vars)}) is absent today, ${formatDay(vars.date)}. Contact the school if unexpected.`,
    ),

  late_advice: (vars, ctx) =>
    fitOneSegment(
      cutWords(vars.studentName, STUDENT_NAME_MAX),
      (name) =>
        `${schoolLabel(ctx.schoolName)}: ${name} (${classSection(vars)}) arrived late today, ${formatDay(vars.date)}${vars.arrivedAt === null ? '' : ` at ${vars.arrivedAt}`}.`,
    ),

  attendance_corrected: (vars, ctx) =>
    fitOneSegment(
      cutWords(vars.studentName, STUDENT_NAME_MAX),
      (name) =>
        `${schoolLabel(ctx.schoolName)}: Correction for ${name} (${classSection(vars)}), ${formatDay(vars.date)}: now marked ${dayWords(vars.status, vars.arrivedAt)}.`,
    ),

  // contracts/slice-11.md §8.4 (R129): push and email only, so no segment limit; the first five
  // sections are named.
  register_unrecorded: (vars, ctx) => {
    const n = vars.sections.length;
    const named = vars.sections
      .slice(0, UNRECORDED_NAMED)
      .map(
        (s) =>
          `${s.className} ${s.sectionName}${s.coverStaffName === null ? '' : ` (cover: ${s.coverStaffName})`}`,
      )
      .join(', ');
    const more = n > UNRECORDED_NAMED ? `, ... (+${n - UNRECORDED_NAMED} more)` : '';
    return `${schoolLabel(ctx.schoolName)}: ${n} ${n === 1 ? 'register' : 'registers'} not recorded by ${vars.deadlineTime} on ${formatDay(vars.date)}: ${named}${more}`.slice(
      0,
      2000,
    );
  },

  // contracts/slice-10.md §6 step 8 (R132).
  cover_assigned: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: You are covering ${vars.className} ${vars.sectionName} from ${formatDay(vars.startsOn)} to ${formatDay(vars.endsOn)}.`,
};

/** The rendered title and body of one message. */
export function renderMessage<T extends MessageType>(
  type: T,
  vars: TemplateVarsMap[T],
  ctx: RenderContext,
): Rendered {
  const render: Renderers[T] = RENDERERS[type];
  return { title: titleOf(type, ctx.subjectType, ctx.schoolName), body: render(vars, ctx) };
}

/** The platform alert (§7.5): school name and id only (R112). No `messages` row. */
export function renderWhatsAppSessionDown(input: {
  schoolName: string;
  schoolId: bigint;
  at: Date;
  errorCode: WhatsAppErrorCode;
}): Rendered {
  return {
    title: `WhatsApp down: ${input.schoolName} (${input.schoolId})`,
    body: `The health check failed at ${input.at.toISOString()} with ${input.errorCode}.`,
  };
}

// ------------------------------------------------------------------------------ masking

/** `+923001234567` -> `+9230*****67`: never seven digits in a row (R111). */
export function maskPhone(e164: string): string {
  if (e164.length <= 6) return '*'.repeat(e164.length);
  return `${e164.slice(0, 5)}*****${e164.slice(-2)}`;
}

/**
 * The push title and email subject of a message: the one table of titles, used when the body is
 * rendered (renderMessage) and when a stored message is sent (the processor; only the body is on
 * the row). Never a person's name or anything from a sender (R111); a type without its own title
 * (an announcement) is titled with the school's name.
 */
export function titleOf(type: MessageType, subjectType: string, schoolName: string): string {
  switch (type) {
    case 'messaging_test':
      return 'Test message';
    case 'sms_cap_reached':
      return 'SMS allowance used up';
    case 'holiday_notice':
      return subjectType === 'holiday_cancellation' ? 'Holiday cancelled' : 'School holiday';
    case 'cover_assigned':
      return 'Cover assignment';
    case 'absence_alert':
      return 'Absent today';
    case 'late_advice':
      return 'Arrived late';
    case 'attendance_corrected':
      return 'Attendance corrected';
    case 'register_unrecorded':
      return 'Registers not recorded';
    case 'diary_posted':
      return 'Diary posted';
    case 'remark_posted':
      return 'New remark';
    default:
      return schoolLabel(schoolName);
  }
}
