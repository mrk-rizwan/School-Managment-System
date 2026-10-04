// R110 (templated SMS fits one GSM-7 segment with the longest fixture values), R111 (no identity
// number, unmasked phone or token in a body) and §7.5's rules: school name first, cut to 30.
import { DEFAULT_SMS_ALLOWED_TYPES, SMS_ELIGIBLE_TYPES } from '@asms/shared';
import { nextMonthStart, yearMonthIn } from '../common/school-clock';
import {
  formatDay,
  maskPhone,
  renderMessage,
  renderWhatsAppSessionDown,
  schoolLabel,
  smsSegments,
  titleOf,
  toGsm7,
} from './templates';

// The longest fixture values (§7.5): a 30-character school name, 40-character person names.
const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const NAME40 = 'Muhammad Abdul Rehman Siddiqui Qureshi K';
const ctx = (subjectType: 'messaging_test' | 'holiday' | 'holiday_cancellation' | 'sms_cap' | 'teacher_assignment') => ({
  schoolName: SCHOOL,
  timezone: 'Asia/Karachi',
  subjectType,
});
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const ID_PATTERN = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
const PHONE_PATTERN = /\+?92[0-9]{10}|0?3[0-9]{9}/;

const rendered = [
  renderMessage('messaging_test', { senderName: NAME40, time: new Date('2026-10-04T04:30:00Z') }, ctx('messaging_test')),
  renderMessage(
    'holiday_notice',
    { name: 'Quaid-e-Azam Day, Christmas and the winter vacation for every class of the junior and senior school', startsOn: D('2026-12-21'), endsOn: D('2026-12-31'), reopensOn: D('2027-01-04') },
    ctx('holiday'),
  ),
  renderMessage(
    'holiday_notice',
    { name: 'Quaid-e-Azam Day, Christmas and the winter vacation for every class of the junior and senior school', startsOn: D('2026-12-21'), endsOn: D('2026-12-31') },
    ctx('holiday_cancellation'),
  ),
  renderMessage('sms_cap_reached', { cap: 100000, nextMonthStart: D('2026-11-01') }, ctx('sms_cap')),
  renderMessage(
    'cover_assigned',
    { className: 'Class Ten Pre-Engineering', sectionName: 'Blue', startsOn: D('2026-10-05'), endsOn: D('2026-10-09') },
    ctx('teacher_assignment'),
  ),
];

describe('templates (contracts/slice-9.md §7.5)', () => {
  it('cuts the school name to 30 characters at a word boundary', () => {
    const label = schoolLabel(SCHOOL);
    expect(label.length).toBeLessThanOrEqual(30);
    expect(SCHOOL.startsWith(label)).toBe(true);
    expect(label).toBe('Government Girls High School');
    expect(schoolLabel('  Short   School ')).toBe('Short School');
  });

  it('every body starts with the school name', () => {
    for (const r of rendered) expect(r.body.startsWith(schoolLabel(SCHOOL))).toBe(true);
  });

  it('R110: every SMS-eligible templated body written here fits one GSM-7 segment with the longest fixtures', () => {
    // holiday_notice is the slice-9/10 SMS-eligible type with a template; the test message goes
    // by SMS too. Both, notice and cancellation, must be one segment.
    for (const r of rendered.slice(0, 3)) expect(smsSegments(toGsm7(r.body))).toBe(1);
    expect(SMS_ELIGIBLE_TYPES).toContain('holiday_notice');
    expect(DEFAULT_SMS_ALLOWED_TYPES).not.toContain('announcement_normal');
  });

  it('R110: a long holiday name is cut with "..." to keep one segment', () => {
    const body = rendered[1]?.body ?? '';
    expect(body).toContain('...');
    expect(body).toMatch(/Reopens Mon 4 Jan\.$/);
  });

  it('R111: no rendered body or title holds an identity number or a phone number', () => {
    for (const r of rendered) {
      expect(r.body).not.toMatch(ID_PATTERN);
      expect(r.body).not.toMatch(PHONE_PATTERN);
      expect(r.title).not.toMatch(ID_PATTERN);
    }
  });

  it('GSM-7: smart quotes, dashes and accents are replaced; an emoji is dropped', () => {
    expect(toGsm7('“Eid” – café … done 🎉')).toBe('"Eid" - café ... done ');
    expect(smsSegments('a'.repeat(160))).toBe(1);
    expect(smsSegments('a'.repeat(161))).toBe(2);
    expect(smsSegments('{'.repeat(81))).toBe(2);
  });

  it('formats days and months in the school calendar', () => {
    expect(formatDay(D('2026-10-05'))).toBe('Mon 5 Oct');
    expect(yearMonthIn('Asia/Karachi', new Date('2026-10-31T19:30:00Z'))).toBe('2026-11');
    expect(nextMonthStart('Asia/Karachi', new Date('2026-12-15T00:00:00Z'))).toEqual(D('2027-01-01'));
  });

  it('R111: a phone is masked with no run of seven digits', () => {
    expect(maskPhone('+923001234567')).toBe('+9230*****67');
    expect(maskPhone('+923001234567')).not.toMatch(/[0-9]{7}/);
  });

  it('R112: the platform alert names the school by name and id only', () => {
    const mail = renderWhatsAppSessionDown({ schoolName: 'Test School', schoolId: 42n, at: new Date('2026-10-04T05:00:00Z'), errorCode: 'logged_out' });
    expect(mail.title).toBe('WhatsApp down: Test School (42)');
    expect(mail.body).toBe('The health check failed at 2026-10-04T05:00:00.000Z with logged_out.');
  });

  it('push titles come from the type, never from a person', () => {
    expect(titleOf('messaging_test', 'messaging_test', SCHOOL)).toBe('Test message');
    expect(titleOf('holiday_notice', 'holiday_cancellation', SCHOOL)).toBe('Holiday cancelled');
  });
});

// contracts/slice-13.md §4.6, §5.4 (R138, R140). Low-priority types: never SMS, so no segment
// limit; the bodies still start with the school name and carry no identity or phone number.
describe('diary and remark templates (contracts/slice-13.md)', () => {
  const diary = (dueOn: Date | null) =>
    renderMessage(
      'diary_posted',
      {
        className: 'Class Five',
        sectionName: 'Blue',
        subjectName: 'Mathematics',
        date: D('2026-10-05'),
        topic: 'Fractions: halves and quarters',
        dueOn,
      },
      { schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType: 'diary_entry' },
    );
  const remark = renderMessage(
    'remark_posted',
    { studentName: NAME40, category: 'behaviour', date: D('2026-10-05') },
    { schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType: 'remark' },
  );

  it('R138: diary_posted names the class, section, subject, date and topic, never the author', () => {
    expect(diary(D('2026-10-09'))).toEqual({
      title: 'Diary posted',
      body: 'Government Girls High School: Class Five Blue Mathematics diary for Mon 5 Oct: Fractions: halves and quarters. Due Fri 9 Oct',
    });
    expect(diary(null).body).toBe(
      'Government Girls High School: Class Five Blue Mathematics diary for Mon 5 Oct: Fractions: halves and quarters',
    );
  });

  it('R140: remark_posted names the student, category and date, and never carries the remark text', () => {
    expect(remark).toEqual({
      title: 'New remark',
      body: `Government Girls High School: A new behaviour remark for ${NAME40} dated Mon 5 Oct. Open the app to read it.`,
    });
  });

  it('R111: neither carries an identity or phone number; neither type is SMS-eligible', () => {
    for (const r of [diary(D('2026-10-09')), remark]) {
      expect(r.body).not.toMatch(ID_PATTERN);
      expect(r.body).not.toMatch(PHONE_PATTERN);
    }
    expect(SMS_ELIGIBLE_TYPES).not.toContain('diary_posted');
    expect(SMS_ELIGIBLE_TYPES).not.toContain('remark_posted');
  });
});
