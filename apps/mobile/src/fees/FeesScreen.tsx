import { formatDay, formatRupees } from '@asms/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Share, StyleSheet, Text, View } from 'react-native';
import { api, unwrap } from '../api/client';
import type { MyClaimDto, MyReceiptDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import { useCachedQuery } from '../db/use-cached-query';
import { discardItem, listLocalClaims, type LocalClaim } from '../db/local.repository';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { useLocalQuery } from '../outbox/runtime';
import { Button } from '../ui/Button';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { localState, StateLine } from '../ui/StateLine';
import { SyncChip } from '../ui/SyncChip';
import { AsOf, cachedOfflineBanner, EmptyState, NoDataState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import {
  CLAIM_STATUS_LABELS,
  claimLine,
  claimsRead,
  DEPOSIT_METHOD_LABELS,
  duesRead,
  forWhat,
  receiptsRead,
  receiptText,
} from './fees';

// A child's Fees — /children/[studentId]/fees (phase-3-financial.md slice 21, §3.9, R198): what is
// owed, the deposit slips on this phone and on the server, and the receipts, rendered natively and
// shared as text. "Upload deposit slip" when the school takes them. Secure: a child's name.

export function FeesScreen({ studentId, secure }: { studentId: string; secure?: boolean }) {
  const router = useRouter();
  const online = useOnline();
  const client = useQueryClient();
  const { me } = useSession();
  const name = me?.body.children.find((c) => c.studentId === studentId)?.fullName ?? '';
  const schoolName = me?.body.school.name ?? '';
  const dues = duesRead(studentId);
  const duesQuery = useCachedQuery(dues.key, dues.path, dues.params, dues.fetch);
  const claims = claimsRead(studentId);
  const claimsQuery = useCachedQuery(claims.key, claims.path, claims.params, claims.fetch);
  const receipts = receiptsRead(studentId);
  const receiptsQuery = useCachedQuery(receipts.key, receipts.path, receipts.params, receipts.fetch);
  const local = useLocalQuery(queryKeys.localClaims(studentId), () => listLocalClaims(studentId));
  const [open, setOpen] = useState<MyReceiptDto | null>(null);
  const [claim, setClaim] = useState<MyClaimDto | null>(null);
  const cached = duesQuery.data;
  // Claims the server already lists are shown there; the phone shows only those still on their way
  // (a claim whose slip was discarded has nothing left on the phone once the server lists it).
  const serverIds = new Set((claimsQuery.data?.body.data ?? []).map((c) => c.id));
  const onPhone = (local.data ?? []).filter(
    (c) => c.serverId === null || !serverIds.has(c.serverId) || (c.slip !== null && c.slip.state !== 'done'),
  );

  return (
    <Screen
      title={name}
      secure={secure}
      accessory={<SyncChip />}
      banner={cachedOfflineBanner(cached, online, duesQuery.isError)}
      onRefresh={() => void client.invalidateQueries({ queryKey: queryKeys.fees(studentId) })}
      testID="fees.screen"
      footer={
        cached?.body.claimsAccepted ? (
          <Button
            label="Upload deposit slip"
            onPress={() => router.push({ pathname: '/children/[studentId]/deposit-slip', params: { studentId } })}
            testID="fees.upload"
          />
        ) : undefined
      }
    >
      <Text style={styles.heading}>Fees</Text>
      {cached === undefined ? (
        <NoDataState
          isError={duesQuery.isError}
          error={duesQuery.error}
          onRetry={() => void duesQuery.refetch()}
          offlineMessage="The fees are not on this phone yet."
        />
      ) : (
        <>
          <AsOf serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
          <Sheet testID="fees.dues">
            <ListRow
              title="Owed"
              detail={cached.body.nextDueOn === null ? undefined : `Next due ${formatDay(cached.body.nextDueOn)}`}
              value={formatRupees(cached.body.outstanding)}
              testID="fees.outstanding"
            />
            {cached.body.advance > 0 ? (
              <ListRow title="Paid in advance" value={formatRupees(cached.body.advance)} />
            ) : null}
            {cached.body.charges.map((c) => (
              <ListRow
                key={c.id}
                title={forWhat(c)}
                detail={`Due ${formatDay(c.dueOn)}`}
                value={formatRupees(c.outstanding)}
                testID={`fees.charge.${c.id}`}
              />
            ))}
          </Sheet>
          {!cached.body.claimsAccepted ? (
            <Text style={styles.caption}>The school takes fees at the office.</Text>
          ) : null}
        </>
      )}

      {onPhone.length > 0 ? (
        <Sheet title="Deposit slips on this phone" testID="fees.local">
          {onPhone.map((c) => (
            <LocalClaimRow key={c.id} claim={c} onDiscarded={() => void local.refetch()} />
          ))}
        </Sheet>
      ) : null}

      {claimsQuery.data && claimsQuery.data.body.data.length > 0 ? (
        <Sheet title="Deposit slips" testID="fees.claims">
          {claimsQuery.data.body.data.map((c) => (
            <ListRow
              key={c.id}
              title={claimLine(c)}
              detail={CLAIM_STATUS_LABELS[c.status]}
              onPress={() => setClaim(c)}
              testID={`fees.claim.${c.id}`}
            />
          ))}
        </Sheet>
      ) : null}

      <Text style={styles.heading}>Receipts</Text>
      {receiptsQuery.data === undefined ? (
        <NoDataState
          isError={receiptsQuery.isError}
          error={receiptsQuery.error}
          onRetry={() => void receiptsQuery.refetch()}
          offlineMessage="The receipts are not on this phone yet."
        />
      ) : receiptsQuery.data.body.data.length === 0 ? (
        <EmptyState title="No receipts yet." />
      ) : (
        <Sheet testID="fees.receipts">
          {receiptsQuery.data.body.data.map((r) => (
            <ListRow
              key={r.id}
              title={`Receipt ${r.receiptLabel}`}
              detail={`${formatDay(r.paidOn)}${r.voidedAt === null ? '' : ' · voided'}`}
              value={formatRupees(r.amount)}
              onPress={() => setOpen(r)}
              testID={`fees.receipt.${r.id}`}
            />
          ))}
        </Sheet>
      )}

      {open ? (
        <ModalSheet
          visible
          title={`Receipt ${open.receiptLabel}`}
          onClose={() => setOpen(null)}
          testID="fees.receiptSheet"
          footer={
            <Button
              label="Share"
              onPress={() => void Share.share({ message: receiptText(open, schoolName) })}
              testID="fees.receipt.share"
            />
          }
        >
          <Text style={styles.body}>{`${formatRupees(open.amount)} paid ${formatDay(open.paidOn)} · ${open.academicYearName}`}</Text>
          {open.lines.map((l, i) => (
            <View key={`${i}-${l.studentId}`} style={styles.row}>
              <Text style={styles.label}>{`${l.studentName}: ${forWhat(l)}`}</Text>
              <Text style={styles.amount}>{formatRupees(l.amount)}</Text>
            </View>
          ))}
          {open.otherChildrenAmount > 0 ? (
            <View style={styles.row}>
              <Text style={styles.label}>Other children</Text>
              <Text style={styles.amount}>{formatRupees(open.otherChildrenAmount)}</Text>
            </View>
          ) : null}
          {open.voidedAt !== null ? <Text style={styles.caption}>This receipt was voided.</Text> : null}
        </ModalSheet>
      ) : null}

      {claim ? <ClaimSheet studentId={studentId} claim={claim} onClose={() => setClaim(null)} /> : null}
    </Screen>
  );
}

/** A slip saved on this phone: the claim's state line, then the slip's. */
function LocalClaimRow({ claim, onDiscarded }: { claim: LocalClaim; onDiscarded: () => void }) {
  const slipLine = (): string => {
    const slip = claim.slip;
    if (slip === null) return 'Slip discarded';
    if (slip.state === 'done') return 'Slip: with the school';
    if (slip.state === 'waiting') return 'Slip: waits for the claim to reach the school';
    if (slip.outbox?.state === 'failed') return `Slip not sent: ${slip.outbox.responseMessage ?? 'refused'}`;
    return 'Slip: sending';
  };
  const outboxId = claim.outbox?.state === 'failed' ? claim.outbox.id : null;
  return (
    <View style={styles.local} testID={`fees.local.${claim.id}`}>
      <ListRow
        title={`${formatRupees(claim.claimedAmount)} · ${DEPOSIT_METHOD_LABELS[claim.method as keyof typeof DEPOSIT_METHOD_LABELS] ?? claim.method}`}
        detail={`Paid ${formatDay(claim.paidOn)}`}
      />
      <StateLine state={localState(claim.outbox, claim.savedOnServerAt)} testID={`fees.local.${claim.id}.state`} />
      <Text style={styles.caption} testID={`fees.local.${claim.id}.slip`}>
        {slipLine()}
      </Text>
      {outboxId !== null ? (
        <Button
          label="Discard"
          variant="destructive"
          onPress={() =>
            Alert.alert('Discard this slip?', 'It has not reached the school.', [
              { text: 'Keep', style: 'cancel' },
              { text: 'Discard', style: 'destructive', onPress: () => void discardItem(outboxId).then(onDiscarded) },
            ])
          }
          testID={`fees.local.${claim.id}.discard`}
        />
      ) : null}
    </View>
  );
}

/** A slip on the server: status, the office's reason; the sender may withdraw it (online only). */
function ClaimSheet({ studentId, claim, onClose }: { studentId: string; claim: MyClaimDto; onClose: () => void }) {
  const client = useQueryClient();
  const gate = useOnlineOnly('withdraw_claim');
  const withdraw = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST('/api/v1/me/children/{id}/payment-claims/{claimId}/withdraw', {
          params: { path: { id: studentId, claimId: claim.id } },
          body: {},
        }),
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.fees(studentId) });
      onClose();
    },
  });
  return (
    <ModalSheet visible title="Deposit slip" onClose={onClose} testID="fees.claimSheet">
      <Text style={styles.body}>{claimLine(claim)}</Text>
      <Text style={styles.body}>{CLAIM_STATUS_LABELS[claim.status]}</Text>
      {claim.reference ? <Text style={styles.caption}>{`Reference ${claim.reference}`}</Text> : null}
      {claim.decisionReason ? <Text style={styles.caption}>{claim.decisionReason}</Text> : null}
      {claim.status === 'verified' && claim.verifiedAmount !== null && claim.verifiedAmount < claim.claimedAmount ? (
        <Text style={styles.caption}>{`You claimed ${formatRupees(claim.claimedAmount)}.`}</Text>
      ) : null}
      {claim.submittedByMe && claim.status === 'pending' ? (
        <Button
          label={gate.enabled ? 'Withdraw' : (gate.reason ?? 'Needs a connection')}
          variant="secondary"
          disabled={!gate.enabled}
          busy={withdraw.isPending}
          onPress={() => withdraw.mutate()}
          testID="fees.claim.withdraw"
        />
      ) : null}
      {withdraw.isError ? <Text style={styles.error}>Could not withdraw. Try again.</Text> : null}
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground, marginTop: space.md },
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
  local: { paddingBottom: space.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs },
  label: { flex: 1, fontSize: fontSize.body, color: colors.foreground },
  amount: { fontSize: fontSize.body, color: colors.foreground, fontVariant: ['tabular-nums'] },
});
