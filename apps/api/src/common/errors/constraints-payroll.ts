// Constraint → refusal mappings for slice 25, merged into BY_CONSTRAINT (prisma-errors.ts). One
// file per slice so the parallel wave-J builds never edit the same file.
//
// Every constraint of the payroll tables (migration 20261006140100_slice25_payroll) that a request
// or a race can reach. The services refuse each first, with ids; these are the fallback when a
// concurrent write gets between the check and the statement. The ones only a bug can break (the
// net formula, the paid columns travelling together, an adjustment line removed, a computed line
// without its kind's shape) stay unmapped: a 500 says "bug", where a 4xx would hide one.
import { ErrorCode } from '@asms/shared';
import { ApiException, concurrentUpdate } from './api-exception';
import { fieldInvalid, noIdentity } from './constraints.shared';

const selfForbidden = (reason: string, message: string) => (): ApiException =>
  new ApiException(409, ErrorCode.SELF_ACTION_FORBIDDEN, message, { reason });

const ownSalary = selfForbidden('own_salary', 'You cannot set your own salary. Ask a colleague.');

const runFinalised = (): ApiException =>
  new ApiException(409, ErrorCode.PAYROLL_RUN_FINALISED, 'This payroll run is finalised and can no longer change.');

const payslipPaid = (): ApiException =>
  new ApiException(409, ErrorCode.PAYSLIP_PAID, 'This payslip is already marked paid.');

const advanceNotOpen = (): ApiException =>
  new ApiException(409, ErrorCode.ADVANCE_NOT_OPEN, 'This advance is already recovered or written off.');

/** The run content a finalise freezes (payroll_runs_content_frozen, asms_forbid_change_unless_status). */
const RUN_CONTENT = ['working_days', 'prepared_at', 'prepared_by', 'staff_count', 'skipped', 'total_net'];
const RUN_FINALISE = ['finalised_at', 'finalised_by', 'finalise_reason'];
const PAYSLIP_PAID = ['paid_on', 'paid_method', 'paid_reference', 'paid_by'];

export const SLICE_25_CONSTRAINTS: Readonly<Record<string, () => ApiException>> = {
  // Salary structures (R213, R235, R253). Writes for one person serialise on the staff row, so the
  // exclusion constraint is reachable only by a bug or a race the lock missed: retryable.
  salary_structures_live_excl: concurrentUpdate,
  salary_structures_not_self: ownSalary,
  salary_structures_self_approved_unwarranted: ownSalary,
  salary_structures_status_transition: concurrentUpdate,
  salary_structures_ended_on_frozen: concurrentUpdate,
  salary_structures_superseded_at_frozen: concurrentUpdate,
  salary_structures_status_frozen: concurrentUpdate,
  salary_structures_reason_no_id_check: noIdentity('reason'),
  salary_structure_components_name_key: fieldInvalid('components', 'two components of one kind share a name'),
  salary_structure_components_name_no_id_check: noIdentity('components'),

  // Advances (R215, R235, R247).
  salary_advances_not_self: selfForbidden('own_advance', 'You cannot grant or write off your own salary advance. Ask a colleague.'),
  salary_advances_instalment_amount_check: fieldInvalid('instalmentAmount', 'instalmentAmount must be at most the amount'),
  salary_advances_recover_from_check: fieldInvalid('recoverFrom', 'recoverFrom must be a month in the form YYYY-MM'),
  salary_advances_paid_reference_no_id_check: noIdentity('paidReference'),
  salary_advances_write_off_reason_no_id_check: noIdentity('reason'),
  salary_advances_status_transition: advanceNotOpen,
  salary_advances_written_off_at_frozen: advanceNotOpen,
  // Two finalises recovering from one advance at once: the second sees the first's counter.
  salary_advances_recovered_check: concurrentUpdate,
  salary_advance_recoveries_advance_open: concurrentUpdate,
  salary_advance_recoveries_advance_payslip_key: concurrentUpdate,

  // Runs (R214, R216).
  payroll_runs_month_key: () =>
    new ApiException(409, ErrorCode.PAYROLL_RUN_EXISTS, 'This month already has a payroll run.'),
  payroll_runs_status_transition: runFinalised,
  ...Object.fromEntries([...RUN_CONTENT, ...RUN_FINALISE].map((column) => [`payroll_runs_${column}_frozen`, runFinalised])),
  payroll_runs_finalise_reason_no_id_check: noIdentity('reason'),

  // Payslips and lines (R216-R218).
  payslips_run_finalised: runFinalised,
  payslips_run_staff_key: concurrentUpdate,
  payslips_status_transition: payslipPaid,
  ...Object.fromEntries(PAYSLIP_PAID.map((column) => [`payslips_${column}_frozen`, payslipPaid])),
  payslips_paid_reference_no_id_check: noIdentity('paidReference'),
  payslip_lines_draft_only: runFinalised,
  payslip_lines_adjusts_finalised: fieldInvalid('adjustsPayslipId', 'only a payslip of a finalised run is corrected'),
  payslip_adjust_not_self: selfForbidden('own_payslip', 'You cannot adjust your own payslip. Ask a colleague.'),
  payslip_lines_name_no_id_check: noIdentity('name'),
  payslip_lines_reason_no_id_check: noIdentity('reason'),
};
