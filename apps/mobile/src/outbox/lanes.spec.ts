import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LANES, laneOf, ONLINE_ONLY_ACTIONS, remedyFor } from './lanes';

// R162, slice-15 §7.3, slice-16 §9: the lane table is normative.

test('no online-only action is an outbox lane', () => {
  const lanes = Object.keys(LANES);
  for (const action of ONLINE_ONLY_ACTIONS) expect(lanes).not.toContain(action);
  for (const lane of Object.values(LANES)) {
    expect(lane.path).not.toMatch(
      /change-password|revoke-others|logout|arrivals|amend|cover|teacher-assignments|announcements/,
    );
  }
});

test('the online-only list after slice 16', () => {
  expect([...ONLINE_ONLY_ACTIONS].sort()).toEqual(
    [
      'change_password',
      'revoke_other_sessions',
      'sign_out',
      'arrivals',
      'amend_after_window',
      'amend_mark',
      'assign_cover',
      'create_announcement',
      'preview_audience',
      'send_announcement',
    ].sort(),
  );
});

test('five lanes, with the §9 paths, methods, senders and local tables', () => {
  expect(Object.keys(LANES).sort()).toEqual(
    ['device_register', 'diary_attachment', 'diary_entry', 'remark', 'submit_register'].sort(),
  );
  expect(LANES.device_register).toMatchObject({
    method: 'POST',
    path: '/api/v1/me/devices',
    sender: 'json',
    domainTable: null,
    label: 'Notification registration',
  });
  expect(LANES.submit_register).toMatchObject({
    method: 'POST',
    path: '/api/v1/sections/:id/submit-register',
    sender: 'json',
    domainTable: 'local_registers',
    label: 'Register',
  });
  expect(LANES.diary_entry).toMatchObject({
    method: 'POST',
    path: '/api/v1/sections/:id/diary-entries',
    sender: 'json',
    domainTable: 'local_diary_entries',
    label: 'Diary entry',
  });
  expect(LANES.remark).toMatchObject({
    method: 'POST',
    path: '/api/v1/students/:id/remarks',
    sender: 'json',
    domainTable: 'local_remarks',
    label: 'Remark',
  });
  expect(LANES.diary_attachment).toMatchObject({
    method: 'PATCH',
    path: '/api/v1/diary-entries/:id',
    sender: 'diary_attachment',
    domainTable: 'local_attachments',
    label: 'Diary photo',
  });
});

test('submit_register is the only coalescing lane; diary_entry and remark the only header lanes', () => {
  const ids = Object.keys(LANES) as (keyof typeof LANES)[];
  expect(ids.filter((id) => LANES[id].coalesces)).toEqual(['submit_register']);
  expect(ids.filter((id) => LANES[id].idempotencyHeader).sort()).toEqual(['diary_entry', 'remark']);
  expect(ids.filter((id) => LANES[id].sender !== 'json')).toEqual(['diary_attachment']);
});

test.each([
  ['submit_register', 'AMENDMENT_REASON_REQUIRED', 'add_reason'],
  ['submit_register', 'ROSTER_INCOMPLETE', 'reload'],
  ['submit_register', 'ATTENDANCE_LOCKED', 'discard'],
  ['submit_register', 'NOT_A_TEACHING_DAY', 'discard'],
  ['submit_register', 'PERMISSION_DENIED', 'discard'],
  ['diary_entry', 'DIARY_ENTRY_EXISTS', 'open_existing'],
  ['diary_entry', 'SUBJECT_NOT_ASSIGNED', 'edit_resend'],
  ['diary_entry', 'ACADEMIC_YEAR_CLOSED', 'edit_resend'],
  ['diary_entry', 'VALIDATION_FAILED', 'edit_resend'],
  ['diary_entry', 'IDEMPOTENCY_KEY_REUSED', 'discard'],
  ['remark', 'STUDENT_NOT_ACTIVE', 'discard'],
  ['remark', 'SUBJECT_ARCHIVED', 'edit_resend'],
  ['remark', 'INVALID_VALUE', 'edit_resend'],
  ['diary_attachment', 'PAYLOAD_TOO_LARGE', 'discard'],
  ['diary_attachment', 'ATTACHMENT_FILE_MISSING', 'discard'],
  ['diary_attachment', 'DIARY_ENTRY_LOCKED', 'discard'],
  ['diary_attachment', 'REFERENCE_NOT_FOUND', 'retry'],
  ['device_register', 'VALIDATION_FAILED', 'discard'],
])('%s, %s → %s', (lane, code, remedy) => {
  expect(remedyFor(lane, code)).toBe(remedy);
});

test('an unknown lane has no table row', () => {
  expect(laneOf('nonsense')).toBeNull();
  expect(remedyFor('nonsense', null)).toBe('discard');
});

// Every direct write a screen makes is online-only: a file under src that calls api.POST (or
// PATCH, PUT) imports useOnlineOnly. The outbox, the session layer and the client itself are the
// exceptions (their writes are queued, or are sign-in and account actions with their own gate).
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('useOnlineOnly wraps every direct write outside the outbox and the session layer', () => {
  const root = join(__dirname, '..');
  const offenders = filesUnder(root)
    .filter((file) => /\.tsx?$/.test(file) && !/\.spec\.tsx?$/.test(file))
    .filter((file) => !/^(outbox|auth|api|test)[\\/]/.test(relative(root, file)))
    .filter((file) => /\bapi\.(POST|PATCH|PUT)\(/.test(readFileSync(file, 'utf8')))
    .filter((file) => !/\buseOnlineOnly\b/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file));
  expect(offenders).toEqual([]);
});
