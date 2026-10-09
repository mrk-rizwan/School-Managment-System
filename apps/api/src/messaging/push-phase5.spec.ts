// phase-5-extended.md §3.4 guardrail: the five Phase 5 types are staff notices, push (title only)
// and email, never SMS. Each is rendered with names, dates and the platform's stated reason; the
// push body the processor would send (pushBodyOf) must be the title alone, carrying none of them,
// and no title names a person. A new Phase 5 type that is not title-only fails here.
import { MESSAGE_TYPE_TABLE, SMS_ELIGIBLE_TYPES, type MessageSubjectType, type MessageType } from '@asms/shared';
import { pushBodyOf } from './message-processor';
import { renderMessage } from './templates';
import type { TemplateVarsMap } from './types';

const SCHOOL = 'Government Girls High School Number 2 Gulshan-e-Iqbal Karachi';
const STAFF = 'Ayesha Siddiqa Rehman';
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const render = <T extends MessageType>(type: T, vars: TemplateVarsMap[T], subjectType: MessageSubjectType) => {
  const { title, body } = renderMessage(type, vars, { schoolName: SCHOOL, timezone: 'Asia/Karachi', subjectType });
  return { type, title, body, push: pushBodyOf(type, title, body) };
};

const RENDERED = [
  render('contract_expiring', { staffName: STAFF, endsOn: day('2026-11-08'), daysLeft: 30 }, 'staff_contract'),
  render(
    'support_session_opened',
    { supportName: 'ASMS Support Desk', reason: 'Checking why receipts print blank', expiresAt: new Date('2026-10-09T13:30:00.000Z') },
    'support_session',
  ),
  render('support_session_closed', { supportName: 'ASMS Support Desk', how: 'revoked' }, 'support_session'),
  render('attendance_disputed', { staffName: STAFF, date: day('2026-10-08') }, 'attendance_dispute'),
  render('attendance_dispute_decided', { date: day('2026-10-08'), decision: 'approved' }, 'attendance_dispute'),
];
const PHASE_5_TYPES: readonly MessageType[] = [
  'contract_expiring',
  'support_session_opened',
  'support_session_closed',
  'attendance_disputed',
  'attendance_dispute_decided',
];

describe('§3.4: Phase 5 staff notices', () => {
  it('every Phase 5 type is rendered here', () => {
    expect(RENDERED.map((r) => r.type)).toEqual(PHASE_5_TYPES);
  });

  it.each(RENDERED.map((r) => [r.type, r] as const))('%s pushes its title only, and the title names nobody', (_type, r) => {
    expect(r.push).toBe(r.title);
    expect(r.title).not.toMatch(/Ayesha|Support Desk|receipts|Nov|Oct/);
    expect(r.body.startsWith('Government Girls High School')).toBe(true);
  });

  it('internal, push and email, never SMS', () => {
    for (const type of PHASE_5_TYPES) {
      expect([type, MESSAGE_TYPE_TABLE[type].priority, MESSAGE_TYPE_TABLE[type].channels]).toEqual([type, 'internal', ['push', 'email']]);
      expect(SMS_ELIGIBLE_TYPES).not.toContain(type);
    }
  });

  it('the support notice says who, why and until when (school time)', () => {
    const opened = RENDERED[1];
    expect(opened?.body).toContain('ASMS Support Desk');
    expect(opened?.body).toContain('Checking why receipts print blank');
    expect(opened?.body).toContain('until 18:30 on Fri 9 Oct');
  });

  it('a contract notice states the end and the days left, and that nothing changes on its own (rule 35)', () => {
    expect(RENDERED[0]?.body).toContain(`${STAFF}'s contract ends on Sun 8 Nov (30 days left)`);
    expect(RENDERED[0]?.body).toContain('nothing changes on its own');
  });
});
