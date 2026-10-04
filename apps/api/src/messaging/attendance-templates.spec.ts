// contracts/slice-11.md §6.5 (R110, R111, R126, R129): the four attendance templates. Each
// SMS-eligible body fits one GSM-7 segment with the longest fixture values (school 30, student 40,
// class and section 16), starts with the school's name and holds no identity or phone number.
import { DAY_STATUSES, SMS_ELIGIBLE_TYPES } from '@asms/shared';
import { cutWords, renderMessage, schoolLabel, smsSegments, toGsm7 } from './templates';

const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const NAME40 = 'Muhammad Abdul Rehman Siddiqui Qureshi K';
const ctx = { schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType: 'attendance_alert' as const };
const date = new Date('2026-09-30T00:00:00.000Z'); // Wed 30 Sep: the longest day label
const who = { studentName: NAME40, className: 'Class Ten Pre-Engineering', sectionName: 'Blue', date };
const ID_PATTERN = /[0-9]{13}|[0-9]{5}-[0-9]{7}-[0-9]/;
const PHONE_PATTERN = /\+?92[0-9]{10}|0?3[0-9]{9}/;

const bodies = [
  renderMessage('absence_alert', who, ctx),
  renderMessage('late_advice', { ...who, arrivedAt: '10:45' }, ctx),
  renderMessage('late_advice', { ...who, arrivedAt: null }, ctx),
  ...DAY_STATUSES.map((status) => renderMessage('attendance_corrected', { ...who, status, arrivedAt: '10:45' }, ctx)),
];

describe('attendance templates (contracts/slice-11.md §6.5)', () => {
  it('R110: the three guardian types are SMS-eligible and every body fits one GSM-7 segment with the longest fixtures', () => {
    for (const type of ['absence_alert', 'late_advice', 'attendance_corrected'] as const) {
      expect(SMS_ELIGIBLE_TYPES).toContain(type);
    }
    for (const r of bodies) {
      expect(r.body.startsWith(`${schoolLabel(SCHOOL)}: `)).toBe(true);
      expect(smsSegments(toGsm7(r.body))).toBe(1);
    }
  });

  it('R111: no body or title holds an identity number or a phone number', () => {
    for (const r of bodies) {
      expect(r.body).not.toMatch(ID_PATTERN);
      expect(r.body).not.toMatch(PHONE_PATTERN);
      expect(r.title).not.toMatch(ID_PATTERN);
    }
  });

  it('R126: the wording and titles of §6.5', () => {
    const short = { studentName: 'Ayesha Siddiqui', className: 'Class 5', sectionName: 'A', date: new Date('2026-10-05T00:00:00.000Z') };
    const s = { ...ctx, schoolName: 'Iqra Model School' };
    expect(renderMessage('absence_alert', short, s)).toEqual({
      title: 'Absent today',
      body: 'Iqra Model School: Ayesha Siddiqui (Class 5 A) is absent today, Mon 5 Oct. Contact the school if unexpected.',
    });
    expect(renderMessage('late_advice', { ...short, arrivedAt: '08:40' }, s)).toEqual({
      title: 'Arrived late',
      body: 'Iqra Model School: Ayesha Siddiqui (Class 5 A) arrived late today, Mon 5 Oct at 08:40.',
    });
    expect(renderMessage('late_advice', { ...short, arrivedAt: null }, s).body).toBe(
      'Iqra Model School: Ayesha Siddiqui (Class 5 A) arrived late today, Mon 5 Oct.',
    );
    const corrected = (status: (typeof DAY_STATUSES)[number], arrivedAt: string | null) =>
      renderMessage('attendance_corrected', { ...short, status, arrivedAt }, s);
    expect(corrected('late', '08:40')).toEqual({
      title: 'Attendance corrected',
      body: 'Iqra Model School: Correction for Ayesha Siddiqui (Class 5 A), Mon 5 Oct: now marked late (arrived 08:40).',
    });
    expect(corrected('late', null).body).toMatch(/now marked late\.$/);
    expect(corrected('partial', null).body).toMatch(/now marked partly absent\.$/);
    expect(corrected('on_leave', null).body).toMatch(/now marked on leave\.$/);
    expect(corrected('present', null).body).toMatch(/now marked present\.$/);
    expect(corrected('absent', null).body).toMatch(/now marked absent\.$/);
  });

  it('R126: longer names are cut at a word boundary with "..." by the template', () => {
    expect(cutWords('Class Ten Pre-Engineering Blue', 16)).toBe('Class Ten...');
    expect(cutWords('Ayesha', 16)).toBe('Ayesha');
    const long = renderMessage('absence_alert', { ...who, studentName: `${NAME40} Bahadur Khan Lodhi` }, ctx).body;
    expect(long).toContain(': Muhammad Abdul Rehman Siddiqui... (Class Ten...) is absent today');
    expect(smsSegments(toGsm7(long))).toBe(1);
  });

  it('R129: register_unrecorded names the first five sections with their cover teacher and counts the rest', () => {
    const sections = Array.from({ length: 7 }, (_, i) => ({
      className: `Class ${i + 1}`,
      sectionName: 'A',
      coverStaffName: i === 0 ? 'Cara Cover' : null,
    }));
    const r = renderMessage('register_unrecorded', { date: new Date('2026-10-05T00:00:00.000Z'), deadlineTime: '10:00', sections }, ctx);
    expect(r.title).toBe('Registers not recorded');
    expect(r.body).toBe(
      'Government Girls High School: 7 registers not recorded by 10:00 on Mon 5 Oct: Class 1 A (cover: Cara Cover), Class 2 A, Class 3 A, Class 4 A, Class 5 A, ... (+2 more)',
    );
    const one = renderMessage('register_unrecorded', { date, deadlineTime: '09:45', sections: sections.slice(1, 2) }, ctx);
    expect(one.body).toMatch(/: 1 register not recorded by 09:45 on Wed 30 Sept?: Class 2 A$/);
  });
});
