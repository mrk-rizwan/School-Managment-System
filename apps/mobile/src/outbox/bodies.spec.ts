import { bindOwner } from '../db/database';
import { saveDiaryEntry, saveRegister, saveRemark } from '../db/local.repository';
import { listByState } from '../db/outbox.repository';
import { resetDevice } from '../test/fake-api';
import { registerView, TODAY } from '../test/fixtures';
import { IDENTITY_PATTERN, PHONE_PATTERN } from '../test/patterns';
import {
  buildAttachmentBody,
  buildDiaryBody,
  buildRegisterBody,
  buildRemarkBody,
  SensitiveTextError,
  sensitiveTextError,
} from './bodies';

// slice-16 §3.4, slice-15 §7.6: an outbox body carries ids and typed text, never a name, an
// identity number or a phone. Each builder is fed screen data that holds all three; the body
// must hold none, and its key set must be exactly the contract's field list for its lane.

/** What a screen has in hand when it saves: the roster row with the child's name and more. */
const screenData = {
  roster: registerView().roster.map((row) => ({
    ...row,
    guardianPhone: '+923001234567',
    bForm: '35202-1234567-1',
  })),
  teacherName: 'Nadia Teacher',
  studentFullName: 'Ali Raza',
};

function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, field]) => [key, ...keysDeep(field)]);
}

function assertNoPersonalData(body: unknown): void {
  const text = JSON.stringify(body);
  expect(keysDeep(body).filter((key) => /name/i.test(key))).toEqual([]);
  expect(text).not.toMatch(IDENTITY_PATTERN);
  expect(text).not.toMatch(PHONE_PATTERN);
  for (const name of ['Ali', 'Sara', 'Bilal', 'Nadia']) expect(text).not.toContain(name);
}

describe('each lane body is the contract field list, with no personal data', () => {
  test('submit_register: { date, period, marks: [{ enrolmentId, status, note?, arrivedAt? }], reason? }', () => {
    const body = buildRegisterBody({
      date: TODAY,
      period: 1,
      // The screen passes the rows it has; anything beyond the mark fields is not copied.
      marks: screenData.roster.map((row, i) => ({
        ...row,
        status: i === 0 ? 'late' : 'present',
        note: i === 0 ? 'Bus' : null,
        arrivedAt: '08:40',
      })),
      reason: 'Corrected by the teacher',
    });
    expect(Object.keys(body).sort()).toEqual(['date', 'marks', 'period', 'reason']);
    expect(Object.keys(body.marks[0]!).sort()).toEqual([
      'arrivedAt',
      'enrolmentId',
      'note',
      'status',
    ]);
    expect(Object.keys(body.marks[1]!).sort()).toEqual(['enrolmentId', 'status']);
    assertNoPersonalData(body);
  });

  test('diary_entry: { date, subjectId, topic, assignment?, learningOutcome?, dueOn? } — never stagedUploadId', () => {
    const body = buildDiaryBody({
      ...screenData,
      date: TODAY,
      subjectId: '7',
      topic: 'Reading: chapter 3',
      assignment: 'Exercise 4',
      learningOutcome: 'Reads aloud',
      dueOn: TODAY,
      stagedUploadId: 'u1',
    } as Parameters<typeof buildDiaryBody>[0]);
    expect(Object.keys(body).sort()).toEqual(
      ['assignment', 'date', 'dueOn', 'learningOutcome', 'subjectId', 'topic'].sort(),
    );
    assertNoPersonalData(body);
  });

  test('remark: { date, category, text, visibility?, subjectId? }; "School default" leaves visibility out', () => {
    const withDefault = buildRemarkBody({
      ...screenData,
      date: TODAY,
      category: 'homework',
      text: 'Homework done well',
      visibility: null,
      subjectId: null,
    });
    expect(Object.keys(withDefault).sort()).toEqual(['category', 'date', 'text']);
    const explicit = buildRemarkBody({
      date: TODAY,
      category: 'general',
      text: 'Good',
      visibility: 'internal',
      subjectId: '7',
    });
    expect(Object.keys(explicit).sort()).toEqual([
      'category',
      'date',
      'subjectId',
      'text',
      'visibility',
    ]);
    assertNoPersonalData(withDefault);
    assertNoPersonalData(explicit);
  });

  test('diary_attachment: { localAttachmentId } only', () => {
    const body = buildAttachmentBody('a-1');
    expect(body).toEqual({ localAttachmentId: 'a-1' });
    assertNoPersonalData(body);
  });
});

describe('typed text with an identity number or a phone is refused before a body is built', () => {
  test.each([
    [
      'a 13-digit note',
      () =>
        buildRegisterBody({
          date: TODAY,
          period: 1,
          marks: [{ enrolmentId: '1', status: 'absent', note: 'B-Form 3520212345671' }],
        }),
    ],
    [
      'a dashed CNIC reason',
      () =>
        buildRegisterBody({
          date: TODAY,
          period: 1,
          marks: [],
          reason: 'Father 35202-1234567-1 called',
        }),
    ],
    [
      'a phone in the topic',
      () => buildDiaryBody({ date: TODAY, subjectId: '7', topic: 'Call 0300 1234567' }),
    ],
    [
      'a phone in the remark',
      () => buildRemarkBody({ date: TODAY, category: 'general', text: 'Ring +92 300 1234567' }),
    ],
  ])('%s', (_name, build) => {
    expect(build).toThrow(SensitiveTextError);
  });

  test('the field check says so in words', () => {
    expect(sensitiveTextError('Roll 12, absent twice')).toBeNull();
    expect(sensitiveTextError('3520212345671')).toBe(
      'Do not type an identity number or a phone number here.',
    );
  });
});

describe('what is stored in the outbox is the body, nothing more', () => {
  beforeEach(async () => {
    await resetDevice();
    await bindOwner('41', '7');
  });

  test('every lane row in SQLite is free of names, identity numbers and phones', async () => {
    await saveRegister({
      sectionId: '12',
      date: TODAY,
      period: 1,
      mode: 'new',
      marks: screenData.roster.map((row) => ({ ...row, status: 'present' as const })),
    });
    await saveDiaryEntry('12', { date: TODAY, subjectId: '7', topic: 'Reading' }, null);
    await saveRemark('501', { date: TODAY, category: 'general', text: 'Good work' });
    const rows = await listByState('pending');
    expect(rows.map((r) => r.lane).sort()).toEqual(['diary_entry', 'remark', 'submit_register']);
    for (const row of rows) assertNoPersonalData(JSON.parse(row.body));
  });
});
