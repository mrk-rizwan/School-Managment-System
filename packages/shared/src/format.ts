import { DEFAULT_TIMEZONE } from './school-fields';

// Display formats, shared by the web and the mobile app (moved from apps/web/lib/format.ts,
// contracts/slice-15.md §2.5). Instants are shown in Pakistan time (CLAUDE.md: Asia/Karachi is
// assumed for every school); a fixed zone also keeps the server render and the browser render
// identical. Intl with timeZone is available in Node, browsers and Hermes on Android.

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeZone: DEFAULT_TIMEZONE,
});
const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: DEFAULT_TIMEZONE,
});
/** An instant (createdAt, endedAt) as its Pakistan calendar day. */
export const formatDate = (iso: string) => dateFormat.format(new Date(iso));
/** An instant as its Pakistan day and time. */
export const formatDateTime = (iso: string) => dateTimeFormat.format(new Date(iso));

// A YYYY-MM-DD date is a calendar day, not an instant: format it in UTC so no zone moves it.
const dayFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });
/** A calendar day (YYYY-MM-DD), such as a date of birth or an academic year's start. */
export const formatDay = (isoDate: string) => dayFormat.format(new Date(`${isoDate}T00:00:00Z`));

const dayInSchoolFormat = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE });
/** The school-time calendar day (YYYY-MM-DD) of an instant. */
export const dayInSchool = (iso: string) => dayInSchoolFormat.format(new Date(iso));
/** Today in the school's time zone, as YYYY-MM-DD. */
export const todayInSchool = () => dayInSchoolFormat.format(new Date());

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: DEFAULT_TIMEZONE,
});
/** An instant as HH:MM (00:00-23:59) in school time. */
export const formatTime = (iso: string) => timeFormat.format(new Date(iso));

/** Whether an instant falls on `today` in school time: a time is shown for it, not a date. */
export const isTodayInSchool = (iso: string, today: string = todayInSchool()) =>
  dayInSchool(iso) === today;
