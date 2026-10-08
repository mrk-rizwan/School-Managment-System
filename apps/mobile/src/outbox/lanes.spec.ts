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

test('the online-only list after Phase 3 (§3.9, R226)', () => {
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
      // Phase 3: every money write but a claim and an expense, and every leave action.
      'record_payment',
      'verify_claim',
      'reject_claim',
      'withdraw_claim',
      'confirm_handover',
      'approve_expense',
      'reject_expense',
      'void_expense',
      'request_leave',
      'cancel_leave',
      'approve_leave',
      'reject_leave',
      // Phase 4 (§0.30): everything but creating a test and entering marks.
      'edit_assessment',
      'void_assessment',
      'excuse_mark',
      // Phase 4 slice 31: every result-sheet action.
      'open_result_sheet',
      'save_result_remarks',
      'submit_result_sheet',
      'approve_result_sheet',
      'return_result_sheet',
      'publish_result_sheet',
    ].sort(),
  );
});

test('eleven lanes, with the §9 and Phase 3 §3.9 paths, methods, senders and local tables', () => {
  expect(Object.keys(LANES).sort()).toEqual(
    [
      'device_register',
      'diary_attachment',
      'diary_entry',
      'remark',
      'submit_register',
      'expense',
      'expense_receipt',
      'payment_claim',
      'payment_claim_image',
      'assessment_create',
      'marks_enter',
    ].sort(),
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
    sender: 'staged_upload_patch',
    domainTable: 'local_attachments',
    label: 'Diary photo',
  });
  expect(LANES.expense).toMatchObject({
    method: 'POST',
    path: '/api/v1/expenses',
    sender: 'json',
    domainTable: 'local_expenses',
    label: 'Expense',
  });
  expect(LANES.expense_receipt).toMatchObject({
    method: 'PATCH',
    path: '/api/v1/expenses/:id/receipt',
    sender: 'staged_upload_patch',
    domainTable: 'local_files',
    label: 'Expense receipt',
  });
  expect(LANES.expense_receipt).not.toHaveProperty('uploadPath');
  // Phase 3 slice 21: a guardian's claim and its slip, uploaded under /me (R78).
  expect(LANES.payment_claim).toMatchObject({
    method: 'POST',
    path: '/api/v1/me/children/:id/payment-claims',
    sender: 'json',
    domainTable: 'local_claims',
    label: 'Deposit slip',
  });
  expect(LANES.payment_claim_image).toMatchObject({
    method: 'PATCH',
    path: '/api/v1/me/children/:id/payment-claims/:claimId',
    sender: 'staged_upload_patch',
    uploadPath: '/api/v1/me/uploads',
    domainTable: 'local_files',
    label: 'Deposit slip photo',
  });
  // Phase 4 slice 30 (§3.8): a class test, then its marks (per-row keys, no header, coalescing).
  expect(LANES.assessment_create).toMatchObject({
    method: 'POST',
    path: '/api/v1/assessments',
    sender: 'json',
    idempotencyHeader: true,
    domainTable: 'local_assessments',
    label: 'Class test',
  });
  expect(LANES.marks_enter).toMatchObject({
    method: 'POST',
    path: '/api/v1/assessments/:id/submit-marks',
    sender: 'json',
    idempotencyHeader: false,
    coalesces: true,
    headers: { Prefer: 'return=minimal' },
    domainTable: 'local_assessment_marks',
    label: 'Marks',
  });
});

// A deposit claim and its image (slice 21) are the other money lanes §3.9 allows.
test('no money write but an expense and a deposit claim (and their files) is a lane (R207, R226)', () => {
  const paths = Object.values(LANES).map((lane) => lane.path);
  for (const path of paths) {
    expect(path).not.toMatch(/\/payments|cash-handovers|approve|reject|void|verify|withdraw|leave/);
  }
  expect(paths.filter((path) => path.includes('/expenses'))).toEqual([
    '/api/v1/expenses',
    '/api/v1/expenses/:id/receipt',
  ]);
  expect(paths.filter((path) => path.includes('/payment-claims'))).toEqual([
    '/api/v1/me/children/:id/payment-claims',
    '/api/v1/me/children/:id/payment-claims/:claimId',
  ]);
});

test('submit_register and marks_enter coalesce; diary_entry, remark, expense, payment_claim and assessment_create carry the header', () => {
  const ids = Object.keys(LANES) as (keyof typeof LANES)[];
  expect(ids.filter((id) => LANES[id].coalesces).sort()).toEqual(['marks_enter', 'submit_register']);
  expect(ids.filter((id) => LANES[id].idempotencyHeader).sort()).toEqual([
    'assessment_create',
    'diary_entry',
    'expense',
    'payment_claim',
    'remark',
  ]);
  expect(ids.filter((id) => LANES[id].sender !== 'json').sort()).toEqual([
    'diary_attachment',
    'expense_receipt',
    'payment_claim_image',
  ]);
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
  ['expense', 'VALIDATION_FAILED', 'edit_resend'],
  ['expense', 'INVALID_VALUE', 'edit_resend'],
  ['expense', 'PERMISSION_DENIED', 'discard'],
  ['expense', 'IDEMPOTENCY_KEY_REUSED', 'discard'],
  ['expense_receipt', 'EXPENSE_RECEIPT_EXISTS', 'discard'],
  ['expense_receipt', 'REFERENCE_NOT_FOUND', 'retry'],
  ['expense_receipt', 'ATTACHMENT_FILE_MISSING', 'discard'],
  ['payment_claim', 'CLAIMS_NOT_ACCEPTED', 'discard'],
  ['payment_claim', 'CLAIM_LIMIT_REACHED', 'discard'],
  ['payment_claim', 'VALIDATION_FAILED', 'discard'],
  ['payment_claim_image', 'CLAIM_NOT_PENDING', 'discard'],
  ['payment_claim_image', 'REFERENCE_NOT_FOUND', 'retry'],
  ['payment_claim_image', 'ATTACHMENT_FILE_MISSING', 'discard'],
  ['assessment_create', 'ASSESSMENT_OUTSIDE_TERM', 'edit_resend'],
  ['assessment_create', 'SUBJECT_NOT_ASSIGNED', 'edit_resend'],
  ['assessment_create', 'IDEMPOTENCY_KEY_REUSED', 'discard'],
  ['marks_enter', 'MARK_EXCEEDS_MAX', 'edit_resend'],
  ['marks_enter', 'ASSESSMENT_LOCKED', 'discard'],
  ['marks_enter', 'ASSESSMENT_VOIDED', 'discard'],
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
