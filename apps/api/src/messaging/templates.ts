// Message templates (contracts/slice-9.md §7.5; contracts/slice-10.md §4.7, §6): English only
// (rule 16), one per type, in code. Every SMS-eligible body starts with the school's name (cut to
// 30 characters at a word boundary) because the sender mask does not show on Telenor or Ufone.
// Bodies never hold an identity number, a token, a password, a phone number or an amount with
// paisa (R111); SMS text is normalised to GSM-7 and each templated body fits one segment with the
// longest fixture values (R110, templates.spec.ts).
import type { DayStatus, MessageSubjectType, MessageType, WhatsAppErrorCode } from '@asms/shared';
import { formatPercentBp, formatRupees } from '@asms/shared';
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
  /** The sender's own composed body (announcement types, contracts/slice-14.md §4.4). */
  body?: string;
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

/** A `YYYY-MM` month as `Oct 2026` (slice 26). */
export const formatMonth = (yearMonth: string): string =>
  `${MONTH.format(new Date(`${yearMonth}-01T00:00:00.000Z`))} ${yearMonth.slice(0, 4)}`;

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
/** contracts/slice-19.md §6: a fee_charged label (`October 2026 fees`, a campaign's name). */
const FEE_LABEL_MAX = 40;

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

/** An instant's calendar day in the school's time zone, as `Mon 6 Oct` (formatDay takes a date). */
const formatDayInZone = (instant: Date, timezone: string): string => {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(instant);
  return formatDay(new Date(`${day}T00:00:00.000Z`));
};

/** A support reason on a principal's notice (platform_support_sessions.reason is at most 500). */
const SUPPORT_REASON_MAX = 200;

/** A term's name on a result message (terms are at most 40 characters). */
const TERM_NAME_MAX = 40;
/** A test's name on test_marked (assessments.name is at most 80). */
const TEST_NAME_MAX = 80;

/** result_published / result_revised: `<School>: <Child>'s <Term> result is published: 78.50 %, grade A. ...` */
function resultBody(
  vars: { studentName: string; termName: string; percentBp: number | null; grade: string | null },
  ctx: RenderContext,
  verb: 'published' | 'revised',
): string {
  const figures =
    vars.percentBp === null || vars.grade === null
      ? ''
      : `: ${formatPercentBp(vars.percentBp)} %, grade ${vars.grade}`;
  const term = cutWords(vars.termName, TERM_NAME_MAX);
  return fitOneSegment(
    cutWords(vars.studentName, STUDENT_NAME_MAX),
    (name) =>
      `${schoolLabel(ctx.schoolName)}: ${name}'s ${term} result is ${verb}${figures}. See the app or collect the report card.`,
  );
}

// ------------------------------------------------------------------------------ templates

/** Each type's body; its title comes from titleOf, the one table of titles. */
type Renderers = {
  [K in MessageType]: (vars: TemplateVarsMap[K], ctx: RenderContext) => string;
};

const notWritten = (type: MessageType) => (): string => {
  throw new Error(`the ${type} template is written by its own slice`);
};

/** An announcement's body is the sender's (composeAnnouncement); there is no template. */
const senderBody = (_vars: Record<string, never>, ctx: RenderContext): string => {
  if (ctx.body === undefined) throw new Error('an announcement is sent with its composed body');
  return ctx.body;
};

const RENDERERS: Renderers = {
  announcement_urgent: senderBody,
  announcement_normal: senderBody,
  whatsapp_session_down: notWritten('whatsapp_session_down'),
  // Phase 3 (§3.6): written by the slice that sends each type.
  // contracts/slice-19.md §6 (R241): SMS-eligible (off by default), so one segment with the
  // longest fixtures; the children's names are cut to fit. The push body is the title (R238).
  fee_charged: (vars, ctx) => {
    const head = `${schoolLabel(ctx.schoolName)}: ${cutWords(vars.label, FEE_LABEL_MAX)}: ${formatRupees(vars.total)} for`;
    const due = `Due ${formatDay(vars.dueOn)}.`;
    return fitOneSegment(vars.children.map((c) => cutWords(c, STUDENT_NAME_MAX)).join(', '), (names) => `${head} ${names}. ${due}`);
  },
  // contracts/slice-22.md §4 (R201, R202): SMS-allowed, so one segment with the longest fixtures;
  // the children's names are cut to fit. The push body is the title (R238).
  fee_due_reminder: (vars, ctx) => {
    const head = `${schoolLabel(ctx.schoolName)}: Fee reminder: ${formatRupees(vars.total)} for`;
    const tail = `is due ${formatDay(vars.dueOn)}. Please pay at the school office.`;
    return fitOneSegment(vars.children.map((c) => cutWords(c, STUDENT_NAME_MAX)).join(', '), (names) => `${head} ${names} ${tail}`);
  },
  fee_overdue: (vars, ctx) => {
    const head = `${schoolLabel(ctx.schoolName)}: Fees overdue: ${formatRupees(vars.overdue)} for`;
    const tail = `unpaid since ${formatDay(vars.since)}. Please pay at the school office.`;
    return fitOneSegment(vars.children.map((c) => cutWords(c, STUDENT_NAME_MAX)).join(', '), (names) => `${head} ${names}, ${tail}`);
  },
  // contracts/slice-20.md §6 (R190): SMS-allowed, so one segment with the longest fixtures; the
  // children's names are cut to fit. Never a link. The push body is the title (R238).
  receipt_issued: (vars, ctx) => {
    const head = `${schoolLabel(ctx.schoolName)}: Receipt ${cutWords(vars.receiptLabel, 30)}: ${formatRupees(vars.amount)} received for`;
    const tail = `Balance for ${cutWords(vars.yearName, 20)}: ${formatRupees(vars.balance)}.`;
    return fitOneSegment(vars.children.map((c) => cutWords(c, STUDENT_NAME_MAX)).join(', '), (names) => `${head} ${names}. ${tail}`);
  },
  // contracts/slice-21.md §5 (R196): SMS-allowed, so one segment with the longest fixtures; the
  // office's reason is cut to fit. Never a link. The push body is the title (R238).
  payment_claim_rejected: (vars, ctx) => {
    const head = `${schoolLabel(ctx.schoolName)}: Deposit slip for ${cutWords(vars.studentName, STUDENT_NAME_MAX)} (${formatRupees(vars.amount)}, ${formatDay(vars.paidOn)}) not accepted:`;
    return fitOneSegment(vars.reason, (reason) => `${head} ${reason}`);
  },
  // contracts/slice-21.md §5 (R200): push and email to the verifiers, once, when the slip lands;
  // no amount (R238), which the claim queue shows.
  payment_claim_submitted: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: A deposit slip for ${cutWords(vars.studentName, STUDENT_NAME_MAX)} is waiting to be verified. Open ASMS to check it.`,
  // contracts/slice-20.md §6 (R193): push and email to the principals; no amount (R238).
  handover_shortfall: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: A cash handover from ${vars.collectorName} was counted short. Open ASMS to resolve it.`,
  // contracts/slice-22.md §4 (R250): push and email to the principals; no amount (R238).
  reminder_sms_capped: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ${vars.families} ${vars.families === 1 ? 'family' : 'families'} could not be reminded by SMS because this month's SMS allowance is used up.`,
  // contracts/slice-19.md §6: push and email to principals and the requester; no amount (R238).
  concession_requested: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: A fee concession for ${cutWords(vars.studentName, STUDENT_NAME_MAX)} was requested by ${vars.requesterName}. Open ASMS to decide.`,
  concession_decided: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: The fee concession you requested for ${cutWords(vars.studentName, STUDENT_NAME_MAX)} was ${vars.decision}.`,
  // Slice 23 (contracts/slice-23.md §4): push and email only; no amount and no reason (R238), so
  // nothing about money travels in a push body; the app and the web console show the expense.
  expense_approval_requested: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: Expense ${vars.expenseNo} (${vars.category.replaceAll('_', ' ')}) recorded by ${vars.recorderName} needs your approval. Open ASMS to review it.`,
  expense_decided: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: Your expense ${vars.expenseNo} was ${vars.decision}. Open ASMS for the details.`,
  // contracts/slice-24.md §5: internal (push and email), so no segment limit; the staff member's
  // name is in the body, never the title (R111).
  leave_requested: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ${vars.staffName} asks for ${vars.typeName}, ${range(vars.startsOn, vars.endsOn)} (${vars.workingDays} working ${vars.workingDays === 1 ? 'day' : 'days'}). Open the app to decide.`,
  leave_decided: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: Your ${vars.typeName}, ${range(vars.startsOn, vars.endsOn)}, was ${vars.decision}.`,
  // Slice 25 (contracts/slice-25.md §7): internal (push and email), no amount (R238); the push body
  // is the title only (the processor's TITLE_ONLY_PUSH).
  payslip_ready: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: Your payslip for ${formatMonth(vars.yearMonth)} is ready. Open ASMS to see it.`,
  // Slice 26 (contracts/slice-26.md §5): to the school's principals, push and email only; no
  // amount (R238), which the settings page's billing status shows.
  platform_invoice_issued: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ASMS subscription invoice ${vars.invoiceNo} for ${formatMonth(vars.yearMonth)} is issued, due ${formatDay(vars.dueOn)}. See Settings for the amount.`,
  platform_invoice_overdue: (vars, ctx) =>
    vars.suspensionEligible
      ? `${schoolLabel(ctx.schoolName)}: ASMS subscription invoice ${vars.invoiceNo} for ${formatMonth(vars.yearMonth)}, due ${formatDay(vars.dueOn)}, is still unpaid and the grace period has ended. Please pay to avoid suspension.`
      : `${schoolLabel(ctx.schoolName)}: ASMS subscription invoice ${vars.invoiceNo} for ${formatMonth(vars.yearMonth)} was due ${formatDay(vars.dueOn)} and is unpaid. See Settings for the amount.`,
  // A platform alert (no messages row): renderBillingTierMissing, sent by PlatformAlerts.
  billing_tier_missing: notWritten('billing_tier_missing'),
  // Phase 4 (phase-4-academic.md §3.5): SMS-allowed, so one segment with the longest fixtures;
  // the child's name and the term are cut to fit. Never the marks table, position or remark. The
  // push body is the title (TITLE_ONLY_PUSH).
  result_published: (vars, ctx) => resultBody(vars, ctx, 'published'),
  result_revised: (vars, ctx) => resultBody(vars, ctx, 'revised'),
  // Low priority, never SMS; never the mark itself.
  test_marked: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ${cutWords(vars.studentName, STUDENT_NAME_MAX)}: ${cutWords(vars.testName, TEST_NAME_MAX)} marked. Open the app to see the mark.`,
  // Phase 5 (phase-5-extended.md §3.4): internal (push and email), never SMS, so no segment limit;
  // names are in the body, never the title (R111), and the push body is the title only
  // (TITLE_ONLY_PUSH).
  contract_expiring: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ${vars.staffName}'s contract ends on ${formatDay(vars.endsOn)} (${vars.daysLeft} ${vars.daysLeft === 1 ? 'day' : 'days'} left). Renew it or end employment in ASMS; nothing changes on its own.`,
  support_session_opened: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ASMS support (${vars.supportName}) has read-only access to your school until ${formatTime(vars.expiresAt, ctx.timezone)} on ${formatDayInZone(vars.expiresAt, ctx.timezone)}. Reason: ${cutWords(vars.reason, SUPPORT_REASON_MAX)}. Every read is in the Audit screen; you may revoke the access there.`,
  support_session_closed: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ASMS support access (${vars.supportName}) ${vars.how === 'expired' ? 'has expired' : vars.how === 'revoked' ? 'was revoked' : 'was closed'}. Every read it made is in the Audit screen.`,
  attendance_disputed: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: ${vars.staffName} disputes their attendance mark for ${formatDay(vars.date)}. Open ASMS to decide.`,
  attendance_dispute_decided: (vars, ctx) =>
    `${schoolLabel(ctx.schoolName)}: Your attendance dispute for ${formatDay(vars.date)} was ${vars.decision}.`,

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

export interface BillingTierMissingInput {
  yearMonth: string;
  skipped: readonly { schoolId: bigint; schoolName: string; reason: 'no_metrics' | 'no_band' }[];
}

/** Schools named in one alert; the rest are counted (the console lists every one). */
const BILLING_ALERT_NAMED = 20;

/**
 * The platform alert billing_tier_missing (slice 26, R220): the scheduled monthly run skipped
 * schools with no student count at most 7 days old (no_metrics) or no plan whose band holds it
 * (no_band). School names and ids only (R112); never a count of anything else.
 */
export function renderBillingTierMissing(input: BillingTierMissingInput): Rendered {
  const named = input.skipped
    .slice(0, BILLING_ALERT_NAMED)
    .map((s) => `- ${s.schoolName} (${s.schoolId}): ${s.reason === 'no_metrics' ? 'no recent student count' : 'no plan band holds its student count'}`);
  const more = input.skipped.length - named.length;
  return {
    title: `Billing: ${input.skipped.length} ${input.skipped.length === 1 ? 'school' : 'schools'} not invoiced for ${formatMonth(input.yearMonth)}`,
    body: [
      `The monthly billing run did not invoice these schools for ${formatMonth(input.yearMonth)}:`,
      ...named,
      ...(more > 0 ? [`... and ${more} more.`] : []),
      'Add a plan for the band, or check the school-metrics rollup, then run "Issue month" on the platform console.',
    ].join('\n'),
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
    case 'fee_charged':
      return 'Fees charged';
    case 'receipt_issued':
      return 'Fee receipt';
    case 'payment_claim_rejected':
      return 'Deposit slip not accepted';
    case 'payment_claim_submitted':
      return 'Deposit slip to verify';
    case 'fee_due_reminder':
      return 'Fee reminder';
    case 'fee_overdue':
      return 'Fees overdue';
    case 'reminder_sms_capped':
      return 'Reminder SMS capped';
    case 'handover_shortfall':
      return 'Cash handover short';
    case 'concession_requested':
      return 'Concession to decide';
    case 'concession_decided':
      return 'Concession decided';
    case 'expense_approval_requested':
      return 'Expense to approve';
    case 'expense_decided':
      return 'Expense decided';
    case 'leave_requested':
      return 'Leave request';
    case 'leave_decided':
      return 'Leave decided';
    case 'payslip_ready':
      return 'Payslip ready';
    case 'platform_invoice_issued':
      return 'Subscription invoice';
    case 'platform_invoice_overdue':
      return 'Subscription invoice overdue';
    case 'result_published':
      return 'Term result published';
    case 'result_revised':
      return 'Term result revised';
    case 'test_marked':
      return 'Test marked';
    case 'contract_expiring':
      return 'Contract ending';
    case 'support_session_opened':
      return 'Support access opened';
    case 'support_session_closed':
      return 'Support access ended';
    case 'attendance_disputed':
      return 'Attendance dispute';
    case 'attendance_dispute_decided':
      return 'Attendance dispute decided';
    default:
      return schoolLabel(schoolName);
  }
}

// ---------------------------------------------------------------------------- announcements

/**
 * Appended to the SMS text of a message with an attachment (R148: "see the app" on SMS, never a
 * URL). The processor's SMS leg adds it; segment counts include it (contracts/slice-14.md §4.5).
 */
export const ATTACHMENT_SMS_LINE = 'Attachment: open the app to view it.';

/**
 * The stored body of an announcement's messages (contracts/slice-14.md §5.4): the school's name,
 * the title and the body. At most 30 + 2 + 120 + 1 + 1,800 = 1,953 characters.
 */
export const composeAnnouncement = (schoolName: string, title: string, body: string): string =>
  `${schoolLabel(schoolName)}: ${title}\n${body}`;

/** The GSM-7 text an SMS leg sends for a stored body (the processor) and its preview (§4.5). */
export const smsTextOf = (body: string, hasAttachment: boolean): string =>
  toGsm7(body) + (hasAttachment ? `\n${ATTACHMENT_SMS_LINE}` : '');

/** A title and body that, composed, fit one SMS segment: `name` is cut to make room (R110). */
function fitHolidayText(
  schoolName: string,
  title: string,
  name: string,
  body: (name: string) => string,
): { title: string; body: string } {
  const fitted = fitOneSegment(name, (n) => composeAnnouncement(schoolName, title, body(n)));
  return { title, body: fitted.slice(composeAnnouncement(schoolName, title, '').length) };
}

/**
 * The announcement that is a holiday's notice (contracts/slice-14.md §6.1, decision 14): title
 * `School closed Mon 6 Oct to Fri 10 Oct`, body `Eid ul Fitr. Reopens Mon 13 Oct.`, one segment
 * with the longest fixtures (the name is cut to fit).
 */
export function holidayNoticeText(
  schoolName: string,
  holiday: { name: string; startsOn: Date; endsOn: Date; reopensOn: Date | null },
): { title: string; body: string } {
  const reopens = holiday.reopensOn === null ? '' : ` Reopens ${formatDay(holiday.reopensOn)}.`;
  return fitHolidayText(
    schoolName,
    cutWords(`School closed ${range(holiday.startsOn, holiday.endsOn)}`, 120),
    holiday.name,
    (name) => `${name}.${reopens}`,
  );
}

/** A published holiday's cancellation notice (§6.2): one segment, the name cut to fit. */
export function holidayCancellationText(
  schoolName: string,
  holiday: { name: string; startsOn: Date; endsOn: Date },
): { title: string; body: string } {
  return fitHolidayText(
    schoolName,
    cutWords(`Holiday cancelled: ${range(holiday.startsOn, holiday.endsOn)}`, 120),
    holiday.name,
    (name) => `The holiday (${name}) is cancelled. School is open as normal.`,
  );
}
