// phase-4-academic.md §3.5 guardrail: a child's result never reaches a lock screen. Each Phase 4
// type is rendered with figures (a percentage, a grade, a test name) and the push body the
// processor would send (pushBodyOf) must be the title alone, carrying none of them; WhatsApp and
// SMS keep the figures, in one segment with the longest fixtures. A new result type that is not
// title-only fails here once it is added to this list.
import { DEFAULT_SMS_ALLOWED_TYPES, SMS_ELIGIBLE_TYPES, type MessageType } from '@asms/shared';
import { pushBodyOf } from './message-processor';
import { renderMessage, smsSegments, toGsm7 } from './templates';
import type { TemplateVarsMap } from './types';

const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const CHILD = 'Muhammad Abdul Rehman Siddiqui Qureshi K';
const TERM = 'Second Term Examination and Assessments';
const FIGURES = /87\.65|grade A\+|Unit 4 Algebra/;

const render = <T extends MessageType>(type: T, vars: TemplateVarsMap[T], subjectType: 'result' | 'assessment') => {
  const { title, body } = renderMessage(type, vars, { schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType });
  return { type, title, body, push: pushBodyOf(type, title, body) };
};

const RESULTS = [
  render('result_published', { studentName: CHILD, termName: TERM, percentBp: 8765, grade: 'A+' }, 'result'),
  render('result_revised', { studentName: CHILD, termName: TERM, percentBp: 8765, grade: 'A+' }, 'result'),
];
const TEST = render('test_marked', { studentName: CHILD, testName: 'Unit 4 Algebra weekly test' }, 'assessment');

describe('§3.5: result and test pushes carry no figure', () => {
  it.each([...RESULTS, TEST].map((r) => [r.type, r] as const))('%s pushes its title only', (_type, r) => {
    expect(r.push).toBe(r.title);
    expect(r.push).not.toMatch(FIGURES);
    expect(r.title).not.toMatch(FIGURES);
    expect(r.title).not.toContain('Muhammad');
  });

  it('the result body keeps the percentage and the grade, in one SMS segment', () => {
    for (const r of RESULTS) {
      expect(r.body).toMatch(/87\.65 %, grade A\+/);
      expect(r.body.startsWith('Government Girls High School')).toBe(true);
      expect(smsSegments(toGsm7(r.body))).toBe(1);
    }
    expect(RESULTS[0]?.body).toContain('result is published');
    expect(RESULTS[1]?.body).toContain('result is revised');
  });

  it('nothing assessed: no figure is printed', () => {
    const r = render('result_published', { studentName: 'Hira Tariq', termName: 'Mid-term', percentBp: null, grade: null }, 'result');
    expect(r.body).toBe(
      "Government Girls High School: Hira Tariq's Mid-term result is published. See the app or collect the report card.",
    );
  });

  it('SMS: both result types allowed by default; test_marked never eligible (R266)', () => {
    expect(DEFAULT_SMS_ALLOWED_TYPES).toEqual(expect.arrayContaining(['result_published', 'result_revised']));
    expect(SMS_ELIGIBLE_TYPES).not.toContain('test_marked');
    expect(TEST.body).toContain('Unit 4 Algebra weekly test marked');
  });
});
