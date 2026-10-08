import { Capability, formatDay, formatRupees } from '@asms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrap } from '../api/client';
import type { ClaimDto, ExpenseDto, HandoverDto, LeaveRequestDto, MeDto, StaffDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { holds } from '../auth/capabilities';
import { useSession } from '../auth/session';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { Attachment } from '../ui/Attachment';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { ReasonSheet } from '../ui/ReasonSheet';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import {
  claimLine,
  claimTitle,
  confirmedMessage,
  decisionFailure,
  digitsOnly,
  expenseLine,
  expenseTitle,
  fetchApprovals,
  handoverLine,
  handoverTitle,
  isNothingDue,
  leaveLine,
  leavePeriod,
  leaveTitle,
  methodWord,
  resultLine,
} from './approvals';
import { sheetTitle } from '../results/results';

// The Approvals tab (phase-3-financial.md slice 27, R226, R227): one screen, the four queues the
// user may act on, each row opening its decision. Online only: offline the screen reads nothing
// and says so; no decision ever enters the outbox. Secure: deposit slips name children and show
// a family's bank slip.

type Open =
  | { kind: 'claim'; row: ClaimDto }
  | { kind: 'handover'; row: HandoverDto }
  | { kind: 'expense'; row: ExpenseDto }
  | { kind: 'leave'; row: LeaveRequestDto };

/** What every decision sheet is given: close with a message (done or stale), or just close. */
type SheetProps = { me: MeDto; onSettled: (message: string) => void; onClose: () => void };

export function ApprovalsScreen({ secure }: { secure: boolean }) {
  const online = useOnline();
  const client = useQueryClient();
  const { me } = useSession();
  const [open, setOpen] = useState<Open | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  const approvals = useQuery({ queryKey: queryKeys.approvals, queryFn: fetchApprovals, enabled: online });

  const refresh = () => void client.invalidateQueries({ queryKey: queryKeys.approvals });
  const settled = (text: string) => {
    setOpen(null);
    setMessage(text);
    refresh();
  };

  if (!online || !me) {
    return (
      <Screen title="Approvals" secure={secure} testID="approvals.screen">
        <EmptyState title="Needs a connection" description="Approvals are read and decided online only. Connect and open this again." />
      </Screen>
    );
  }

  const data = approvals.data;
  const sheet: SheetProps = { me: me.body, onSettled: settled, onClose: () => setOpen(null) };
  return (
    <Screen title="Approvals" secure={secure} testID="approvals.screen" onRefresh={refresh} refreshing={approvals.isFetching}>
      {message !== null ? (
        <Text style={styles.message} testID="approvals.message">
          {message}
        </Text>
      ) : null}
      {approvals.isPending ? (
        <LoadingState />
      ) : approvals.isError || !data ? (
        <ErrorState error={approvals.error} onRetry={() => void approvals.refetch()} />
      ) : !data.claims && !data.handovers && !data.expenses && !data.leave && !data.results ? (
        <EmptyState title="Nothing for you to approve" />
      ) : (
        <>
          {data.claims ? (
            <Section title="Deposit slips" count={data.claims.count} testID="approvals.claims" empty="No deposit slips are waiting.">
              {data.claims.items.map((c) => (
                <ListRow
                  key={c.id}
                  title={claimTitle(c)}
                  detail={claimLine(c)}
                  value={c.possibleDuplicate ? 'Possible duplicate' : null}
                  onPress={() => setOpen({ kind: 'claim', row: c })}
                  testID={`approvals.claim.${c.id}`}
                />
              ))}
            </Section>
          ) : null}
          {data.handovers ? (
            <Section title="Cash handovers" count={data.handovers.count} testID="approvals.handovers" empty="No cash is waiting to be counted.">
              {data.handovers.items.map((h) => (
                <ListRow
                  key={h.id}
                  title={handoverTitle(h)}
                  detail={handoverLine(h)}
                  onPress={() => setOpen({ kind: 'handover', row: h })}
                  testID={`approvals.handover.${h.id}`}
                />
              ))}
            </Section>
          ) : null}
          {data.expenses ? (
            <Section title="Expenses" count={data.expenses.count} testID="approvals.expenses" empty="No expenses are waiting for approval.">
              {data.expenses.items.map((e) => (
                <ListRow
                  key={e.id}
                  title={expenseTitle(e)}
                  detail={expenseLine(e)}
                  onPress={() => setOpen({ kind: 'expense', row: e })}
                  testID={`approvals.expense.${e.id}`}
                />
              ))}
            </Section>
          ) : null}
          {data.results ? (
            <Section title="Result sheets" count={data.results.count} testID="approvals.results" empty="No result sheets are waiting.">
              {data.results.items.map((r) => (
                <ListRow
                  key={r.id}
                  title={sheetTitle(r)}
                  detail={resultLine(r)}
                  value={r.ownChildFlags.length > 0 ? 'Own child' : r.cover ? 'Cover' : null}
                  onPress={() => router.push({ pathname: '/approvals/sheet/[id]', params: { id: r.id } })}
                  testID={`approvals.result.${r.id}`}
                />
              ))}
            </Section>
          ) : null}
          {data.leave ? (
            <Section title="Staff leave" count={data.leave.count} testID="approvals.leave" empty="No leave requests are waiting.">
              {data.leave.items.map((l) => (
                <ListRow
                  key={l.id}
                  title={leaveTitle(l)}
                  detail={leaveLine(l)}
                  onPress={() => setOpen({ kind: 'leave', row: l })}
                  testID={`approvals.leave.${l.id}`}
                />
              ))}
            </Section>
          ) : null}
        </>
      )}
      {open?.kind === 'claim' ? <ClaimSheet key={open.row.id} claim={open.row} {...sheet} /> : null}
      {open?.kind === 'handover' ? <HandoverSheet key={open.row.id} handover={open.row} {...sheet} /> : null}
      {open?.kind === 'expense' ? <ExpenseSheet key={open.row.id} expense={open.row} {...sheet} /> : null}
      {open?.kind === 'leave' ? <LeaveSheet key={open.row.id} request={open.row} {...sheet} /> : null}
    </Screen>
  );
}

function Section({
  title,
  count,
  empty,
  testID,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <Sheet title={`${title} · ${count}`} testID={testID}>
      {count === 0 ? <Text style={styles.note}>{empty}</Text> : children}
      {count > 10 ? <Text style={styles.note}>{`Showing the first 10 of ${count}. The rest are on the web console.`}</Text> : null}
    </Sheet>
  );
}

/** Runs one decision: busy while it runs; a 409 or 404 settles the screen with the server's word. */
function useDecision(onSettled: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  async function run(send: () => Promise<string>, onError?: (error: unknown) => boolean) {
    setBusy(true);
    setFailure(null);
    try {
      onSettled(await send());
    } catch (error) {
      if (onError?.(error)) return;
      const outcome = decisionFailure(error);
      if (outcome.stale) onSettled(outcome.message);
      else setFailure(outcome.message);
    } finally {
      setBusy(false);
    }
  }
  return { busy, failure, setFailure, run };
}

function Lines({ lines }: { lines: (string | null)[] }) {
  return (
    <>
      {lines.filter((l): l is string => l !== null).map((line) => (
        <Text key={line} style={styles.body}>
          {line}
        </Text>
      ))}
    </>
  );
}

// ------------------------------------------------------------------------------- deposit slip

function ClaimSheet({ claim, onSettled, onClose }: SheetProps & { claim: ClaimDto }) {
  const online = useOnline();
  const verifyGate = useOnlineOnly('verify_claim');
  const rejectGate = useOnlineOnly('reject_claim');
  const { busy, failure, setFailure, run } = useDecision(onSettled);
  const [nothingDue, setNothingDue] = useState(false);
  const [rejecting, setRejecting] = useState(false);

  const verify = (asAdvance: boolean) =>
    run(
      async () => {
        const verified = await unwrap(
          api.POST('/api/v1/payment-claims/{id}/verify', {
            params: { path: { id: claim.id } },
            body: asAdvance ? { advanceForStudentId: claim.studentId } : {},
          }),
        );
        return `Verified: receipt ${verified.payment.receipt?.receiptLabel ?? ''} for ${formatRupees(verified.payment.amount)}.`;
      },
      (error) => {
        if (asAdvance || !isNothingDue(error)) return false;
        setNothingDue(true);
        setFailure(`Nothing is owed by ${claim.studentName} this year. Keep the money as the child's advance, or do not accept the slip.`);
        return true;
      },
    );

  if (rejecting) {
    return (
      <ReasonSheet
        visible
        title="Do not accept this slip"
        changes={[`${claimTitle(claim)}. The parent gets the reason by WhatsApp or SMS; no phone numbers.`]}
        confirmLabel="Not accepted"
        busy={busy}
        disabledReason={rejectGate.reason}
        onConfirm={(reason) =>
          void run(async () => {
            await unwrap(api.POST('/api/v1/payment-claims/{id}/reject', { params: { path: { id: claim.id } }, body: { reason } }));
            return 'Slip not accepted. The parent is told why.';
          })
        }
        onClose={() => setRejecting(false)}
      />
    );
  }

  return (
    <ModalSheet
      visible
      title="Deposit slip"
      onClose={onClose}
      testID="approvals.claimSheet"
      footer={
        <>
          {failure !== null ? (
            <Text style={styles.error} testID="approvals.claim.failure">
              {failure}
            </Text>
          ) : null}
          {verifyGate.reason ? <Text style={styles.note}>{verifyGate.reason}</Text> : null}
          {nothingDue ? (
            <Button
              label="Keep as the child's advance"
              onPress={() => void verify(true)}
              disabled={!verifyGate.enabled}
              busy={busy}
              testID="approvals.claim.advance"
            />
          ) : (
            <Button
              label={`Verify ${formatRupees(claim.claimedAmount)}`}
              onPress={() => void verify(false)}
              disabled={!verifyGate.enabled || !claim.hasImage}
              busy={busy}
              testID="approvals.claim.verify"
            />
          )}
          <Button
            label="Not accepted…"
            variant="secondary"
            onPress={() => setRejecting(true)}
            disabled={!rejectGate.enabled}
            testID="approvals.claim.reject"
          />
        </>
      }
    >
      <Text style={styles.heading}>{claimTitle(claim)}</Text>
      <Lines
        lines={[
          `${claim.className}, sent by ${claim.guardianName}`,
          `${methodWord(claim.method)}, paid ${formatDay(claim.paidOn)}`,
          claim.reference ? `Reference ${claim.reference}` : null,
          claim.note ? `Note: ${claim.note}` : null,
        ]}
      />
      {claim.possibleDuplicate ? (
        <Text style={styles.warning} testID="approvals.claim.duplicate">
          Another slip has the same method, reference and date. Check it is not the same payment twice.
        </Text>
      ) : null}
      <Attachment
        basePath={`/api/v1/payment-claims/${claim.id}`}
        originalPath={`/api/v1/payment-claims/${claim.id}/image`}
        mime={claim.imageMime}
        sizeBytes={null}
        online={online}
        label="Deposit slip"
      />
      <Text style={styles.note}>A lower amount or another paid date is verified on the web console.</Text>
    </ModalSheet>
  );
}

// ----------------------------------------------------------------------------------- handover

function HandoverSheet({ handover, me, onSettled, onClose }: SheetProps & { handover: HandoverDto }) {
  const gate = useOnlineOnly('confirm_handover');
  const { busy, failure, run } = useDecision(onSettled);
  const [counted, setCounted] = useState(String(handover.expectedAmount));
  // Never the collector or whoever opened it (R194): the server refuses it too.
  const own = handover.collector.userId === me.id || handover.openedByUserId === me.id;
  const amount = Number(counted);
  const problem = counted === '' ? 'Enter the cash you counted.' : null;

  return (
    <ModalSheet
      visible
      title="Cash handover"
      onClose={onClose}
      testID="approvals.handoverSheet"
      footer={
        <>
          {failure !== null ? (
            <Text style={styles.error} testID="approvals.handover.failure">
              {failure}
            </Text>
          ) : null}
          {gate.reason ? <Text style={styles.note}>{gate.reason}</Text> : null}
          <Button
            label="Confirm the count"
            onPress={() =>
              void run(async () => {
                await unwrap(
                  api.POST('/api/v1/cash-handovers/{id}/confirm', {
                    params: { path: { id: handover.id } },
                    body: { countedAmount: amount },
                  }),
                );
                return confirmedMessage(handover.expectedAmount, amount);
              })
            }
            disabled={!gate.enabled || own || problem !== null}
            busy={busy}
            testID="approvals.handover.confirm"
          />
        </>
      }
    >
      <Text style={styles.heading}>{handoverTitle(handover)}</Text>
      <Lines lines={[handoverLine(handover), handover.note ? `Note: ${handover.note}` : null]} />
      {own ? (
        <Text style={styles.note} testID="approvals.handover.own">
          {"Your own cash: another person counts it."}
        </Text>
      ) : null}
      <Field
        label="Cash counted (Rs)"
        value={counted}
        onChangeText={(text) => setCounted(digitsOnly(text))}
        keyboardType="number-pad"
        error={problem}
        testID="approvals.handover.counted"
      />
    </ModalSheet>
  );
}

// ------------------------------------------------------------------------------------ expense

function ExpenseSheet({ expense, me, onSettled, onClose }: SheetProps & { expense: ExpenseDto }) {
  const online = useOnline();
  const approveGate = useOnlineOnly('approve_expense');
  const rejectGate = useOnlineOnly('reject_expense');
  const { busy, failure, run } = useDecision(onSettled);
  const [rejecting, setRejecting] = useState(false);
  // Never the recorder (R206): the server refuses it too.
  const own = expense.recordedByUserId === me.id;
  // The version read: an edit since then is refused (409 CONCURRENT_UPDATE) and the list reloads.
  const expectedUpdatedAt = expense.updatedAt;

  if (rejecting) {
    return (
      <ReasonSheet
        visible
        title="Reject this expense"
        changes={[expenseTitle(expense)]}
        confirmLabel="Reject"
        busy={busy}
        disabledReason={rejectGate.reason}
        onConfirm={(reason) =>
          void run(async () => {
            await unwrap(
              api.POST('/api/v1/expenses/{id}/reject', {
                params: { path: { id: expense.id } },
                body: { expectedUpdatedAt, reason },
              }),
            );
            return 'Expense rejected. The recorder is told.';
          })
        }
        onClose={() => setRejecting(false)}
      />
    );
  }

  return (
    <ModalSheet
      visible
      title="Expense"
      onClose={onClose}
      testID="approvals.expenseSheet"
      footer={
        <>
          {failure !== null ? (
            <Text style={styles.error} testID="approvals.expense.failure">
              {failure}
            </Text>
          ) : null}
          {approveGate.reason ? <Text style={styles.note}>{approveGate.reason}</Text> : null}
          <Button
            label="Approve"
            onPress={() =>
              void run(async () => {
                await unwrap(
                  api.POST('/api/v1/expenses/{id}/approve', {
                    params: { path: { id: expense.id } },
                    body: { expectedUpdatedAt },
                  }),
                );
                return 'Expense approved. The recorder is told.';
              })
            }
            disabled={!approveGate.enabled || own}
            busy={busy}
            testID="approvals.expense.approve"
          />
          <Button
            label="Reject…"
            variant="secondary"
            onPress={() => setRejecting(true)}
            disabled={!rejectGate.enabled || own}
            testID="approvals.expense.reject"
          />
        </>
      }
    >
      <Text style={styles.heading}>{expenseTitle(expense)}</Text>
      <Lines
        lines={[
          expenseLine(expense),
          expense.payee ? `Paid to ${expense.payee}` : null,
          expense.reference ? `Reference ${expense.reference}` : null,
        ]}
      />
      {own ? (
        <Text style={styles.note} testID="approvals.expense.own">
          {'Your own expense: another approver decides it.'}
        </Text>
      ) : null}
      {expense.hasReceipt ? (
        <Attachment
          basePath={`/api/v1/expenses/${expense.id}/receipt`}
          originalPath={`/api/v1/expenses/${expense.id}/receipt`}
          mime={expense.receiptMime}
          sizeBytes={null}
          online={online}
          label="Expense receipt"
        />
      ) : null}
    </ModalSheet>
  );
}

// -------------------------------------------------------------------------------------- leave

type StaffChoice = Pick<StaffDto, 'id' | 'fullName' | 'designation'>;
/** The API's page cap (50): the picker reads one page, no search. */
const STAFF_PAGE = 50;

function LeaveSheet({ request, me, onSettled, onClose }: SheetProps & { request: LeaveRequestDto }) {
  const approveGate = useOnlineOnly('approve_leave');
  const rejectGate = useOnlineOnly('reject_leave');
  const { busy, failure, run } = useDecision(onSettled);
  const [rejecting, setRejecting] = useState(false);
  // A cover is a teacher assignment, which needs class.manage (the server refuses it otherwise).
  const canCover = holds(me, Capability.CLASS_MANAGE) && request.sectionsNeedingCover.length > 0;
  const [sectionId, setSectionId] = useState<string | null>(request.sectionsNeedingCover[0]?.sectionId ?? null);
  const [cover, setCover] = useState<StaffChoice | null>(null);
  const staff = useQuery({
    queryKey: queryKeys.coverStaff,
    queryFn: async (): Promise<{ choices: StaffChoice[]; more: boolean }> => {
      const page = await unwrap(
        api.GET('/api/v1/staff', { params: { query: { status: 'active', limit: STAFF_PAGE, page: 1 } } }),
      );
      // Only what the picker shows stays in memory: never a phone or an identity number.
      return {
        choices: page.data.map(({ id, fullName, designation }) => ({ id, fullName, designation })),
        more: page.total > STAFF_PAGE,
      };
    },
    enabled: canCover,
  });

  if (rejecting) {
    return (
      <ReasonSheet
        visible
        title="Reject this leave"
        changes={[`${leaveTitle(request)}: ${leavePeriod(request)}`]}
        confirmLabel="Reject"
        busy={busy}
        disabledReason={rejectGate.reason}
        onConfirm={(reason) =>
          void run(async () => {
            await unwrap(
              api.POST('/api/v1/leave-requests/{id}/reject', { params: { path: { id: request.id } }, body: { reason } }),
            );
            return `Leave rejected. ${request.staffName} is told.`;
          })
        }
        onClose={() => setRejecting(false)}
      />
    );
  }

  const withCover = cover !== null && sectionId !== null;
  return (
    <ModalSheet
      visible
      title="Leave request"
      onClose={onClose}
      testID="approvals.leaveSheet"
      footer={
        <>
          {failure !== null ? (
            <Text style={styles.error} testID="approvals.leave.failure">
              {failure}
            </Text>
          ) : null}
          {approveGate.reason ? <Text style={styles.note}>{approveGate.reason}</Text> : null}
          <Button
            label={withCover ? `Approve, ${cover.fullName} covers` : 'Approve'}
            onPress={() =>
              void run(async () => {
                await unwrap(
                  api.POST('/api/v1/leave-requests/{id}/approve', {
                    params: { path: { id: request.id } },
                    body: withCover ? { cover: { sectionId, coverStaffId: cover.id } } : {},
                  }),
                );
                return withCover
                  ? `Leave approved; ${cover.fullName} covers. Both are told.`
                  : `Leave approved. ${request.staffName} is told.`;
              })
            }
            disabled={!approveGate.enabled}
            busy={busy}
            testID="approvals.leave.approve"
          />
          <Button
            label="Reject…"
            variant="secondary"
            onPress={() => setRejecting(true)}
            disabled={!rejectGate.enabled}
            testID="approvals.leave.reject"
          />
        </>
      }
    >
      <Text style={styles.heading}>{leaveTitle(request)}</Text>
      <Lines
        lines={[
          `${leavePeriod(request)} · ${request.workingDays} working ${request.workingDays === 1 ? 'day' : 'days'}`,
          `Reason: ${request.reason}`,
        ]}
      />
      {request.sectionsNeedingCover.length > 0 && !canCover ? (
        <Text style={styles.note}>{`Class teacher of ${request.sectionsNeedingCover.map((s) => s.name).join(', ')}: a cover is arranged by someone who manages classes.`}</Text>
      ) : null}
      {canCover ? (
        <>
          <Text style={styles.label}>Cover (optional)</Text>
          {request.sectionsNeedingCover.length > 1 ? (
            <SegmentedPicker
              label="Section"
              options={request.sectionsNeedingCover.map((s) => ({ value: s.sectionId, label: s.name }))}
              value={sectionId}
              onChange={setSectionId}
              testID="approvals.leave.section"
            />
          ) : (
            <Text style={styles.note}>{`For ${request.sectionsNeedingCover[0]?.name ?? ''}`}</Text>
          )}
          {staff.isPending ? (
            <LoadingState />
          ) : staff.isError ? (
            <Text style={styles.note}>Cannot load the staff list. Approve without a cover, or try again.</Text>
          ) : (
            <>
              {staff.data.choices
                .filter((s) => s.id !== request.staffId)
                .map((s) => (
                  <ListRow
                    key={s.id}
                    title={s.fullName}
                    detail={s.designation}
                    value={cover?.id === s.id ? 'Chosen' : null}
                    onPress={() => setCover(cover?.id === s.id ? null : s)}
                    testID={`approvals.leave.cover.${s.id}`}
                  />
                ))}
              {staff.data.more ? (
                <Text style={styles.note} testID="approvals.leave.coverMore">
                  {`Showing the first ${STAFF_PAGE} staff; choose the cover on the web if not listed.`}
                </Text>
              ) : null}
            </>
          )}
        </>
      ) : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  message: { fontSize: fontSize.body, color: colors.foreground },
  heading: { fontSize: fontSize.body, fontWeight: '600', color: colors.foreground },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground, marginTop: space.sm },
  body: { fontSize: fontSize.body, color: colors.foreground },
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  warning: { fontSize: fontSize.small, color: colors.destructive },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
