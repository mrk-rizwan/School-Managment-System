// The pure pieces of slice 14 (contracts/slice-14.md §2.1, §4.1, §4.5, §5.4, §6; R110): the shared
// audience helpers the API, web and app use, the composed body and the holiday announcements' text.
import {
  audiencesProblem,
  messageTypeOf,
  normaliseAudiences,
  type AudienceInput,
} from '@asms/shared';
import {
  ATTACHMENT_SMS_LINE,
  composeAnnouncement,
  holidayCancellationText,
  holidayNoticeText,
  smsSegments,
  smsTextOf,
  toGsm7,
} from '../../src/messaging/templates';
import { audienceKinds } from '../../src/modules/announcements/announcements.service';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const LONG_SCHOOL = 'The Educators Model High School For Boys and Girls'; // cut to 30
const LONG_NAME = 'Eid ul Adha and the national holidays declared by the provincial government of Punjab for all schools';

describe('audience helpers (packages/shared)', () => {
  it('audiencesProblem names each §4.1 refusal', () => {
    const cases: [AudienceInput[], ReturnType<typeof audiencesProblem>][] = [
      [[], { index: null, reason: 'empty' }],
      [Array.from({ length: 21 }, (_, i) => ({ kind: 'student' as const, targetId: String(i + 1) })), { index: null, reason: 'too_many' }],
      [[{ kind: 'everyone' }, { kind: 'parents' }], { index: null, reason: 'everyone_not_alone' }],
      [[{ kind: 'staff', targetId: '1' }], { index: 0, reason: 'target_forbidden' }],
      [[{ kind: 'parents' }, { kind: 'class' }], { index: 1, reason: 'target_required' }],
      [[{ kind: 'guardian', targetId: '1', roles: ['parents'] }], { index: 0, reason: 'roles_forbidden' }],
      [[{ kind: 'class', targetId: '1', roles: [] }], { index: 0, reason: 'roles_empty' }],
      [[{ kind: 'class', targetId: '1' }, { kind: 'class', targetId: '1', roles: ['students'] }], { index: 1, reason: 'duplicate' }],
      [[{ kind: 'parents' }, { kind: 'students' }, { kind: 'class', targetId: '2', roles: ['parents', 'students'] }], null],
    ];
    for (const [audiences, problem] of cases) expect(audiencesProblem(audiences)).toEqual(problem);
  });

  it('normaliseAudiences orders by kind then id, merges duplicates and keeps everyone alone', () => {
    expect(
      normaliseAudiences([
        { kind: 'student', targetId: '10' },
        { kind: 'section', targetId: '9' },
        { kind: 'section', targetId: '10', roles: ['students'] },
        { kind: 'section', targetId: '10', roles: ['parents'] },
        { kind: 'parents' },
      ]),
    ).toEqual([
      { kind: 'parents' },
      { kind: 'section', targetId: '9' },
      { kind: 'section', targetId: '10', roles: ['parents', 'students'] },
      { kind: 'student', targetId: '10' },
    ]);
    expect(normaliseAudiences([{ kind: 'staff' }, { kind: 'everyone' }])).toEqual([{ kind: 'everyone' }]);
  });

  it('messageTypeOf: a holiday notice keeps its own type; otherwise by priority', () => {
    expect(messageTypeOf({ priority: 'urgent', holidayId: '3' })).toBe('holiday_notice');
    expect(messageTypeOf({ priority: 'urgent', holidayId: null })).toBe('announcement_urgent');
    expect(messageTypeOf({ priority: 'normal', holidayId: null })).toBe('announcement_normal');
  });

  it('R152 audienceKinds: broad kinds by name, targeted kinds with their count; never an id', () => {
    expect(audienceKinds([{ kind: 'everyone', targetId: null }])).toBe('everyone');
    expect(
      audienceKinds([
        { kind: 'class', targetId: 4n },
        { kind: 'class', targetId: 5n },
        { kind: 'section', targetId: 9n },
      ]),
    ).toBe('class:2,section:1');
  });
});

describe('announcement text (templates.ts)', () => {
  it('§5.4: the stored body starts with the school name; the SMS adds the attachment line and counts it', () => {
    const body = composeAnnouncement(LONG_SCHOOL, 'Closed', 'Rain');
    expect(body).toBe('The Educators Model High: Closed\nRain');
    expect(smsTextOf(body, true)).toBe(`${body}\n${ATTACHMENT_SMS_LINE}`);
    const near = composeAnnouncement('Iqra', 'T', 'x'.repeat(160 - 'Iqra: T\n'.length));
    expect([smsSegments(smsTextOf(near, false)), smsSegments(smsTextOf(near, true))]).toEqual([1, 2]);
  });

  it('R110 §6.1: the holiday notice and its cancellation fit one GSM-7 segment with the longest fixtures', () => {
    const holiday = { name: LONG_NAME, startsOn: day('2026-10-05'), endsOn: day('2026-10-09') };
    const notice = holidayNoticeText(LONG_SCHOOL, { ...holiday, reopensOn: day('2026-10-12') });
    expect(notice.title).toBe('School closed Mon 5 Oct to Fri 9 Oct');
    expect(notice.body).toMatch(/^Eid ul Adha .*\.\.\.\. Reopens Mon 12 Oct\.$/);
    expect(smsSegments(toGsm7(composeAnnouncement(LONG_SCHOOL, notice.title, notice.body)))).toBe(1);
    const short = holidayNoticeText('Iqra', { name: 'Eid', startsOn: day('2026-10-05'), endsOn: day('2026-10-05'), reopensOn: null });
    expect(short).toEqual({ title: 'School closed Mon 5 Oct', body: 'Eid.' });
    const cancelled = holidayCancellationText(LONG_SCHOOL, holiday);
    expect(cancelled.title).toBe('Holiday cancelled: Mon 5 Oct to Fri 9 Oct');
    expect(cancelled.body).toMatch(/^The holiday \(.+\) is cancelled\. School is open as normal\.$/);
    expect(smsSegments(toGsm7(composeAnnouncement(LONG_SCHOOL, cancelled.title, cancelled.body)))).toBe(1);
  });
});
