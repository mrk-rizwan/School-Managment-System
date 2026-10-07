import { formatDay, formatRupees, monthLabel } from '@asms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import type { PayslipDto } from '../api/contracts';
import { useSession } from '../auth/session';
import { useOnline } from '../net/connectivity';
import { Button } from '../ui/Button';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { Paging } from '../ui/Paging';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import {
  fetchPayslips,
  fetchSalary,
  paidLine,
  PAYSLIP_LIMIT,
  payslipKeys,
  payslipRows,
  payslipText,
} from './my-payslips';

// My payslips (slice 25, R217): the Home card and /home/my-payslips. Online read only: offline the
// screen shows nothing stale and says it needs a connection. Payslips are rendered natively and
// shared as text (§3.5). The user's own data: not a secure screen.

/** The Home card: opens My payslips. Reads nothing, so it costs no request on Home. */
export function MyPayslipsCard() {
  const router = useRouter();
  return (
    <Sheet testID="home.myPayslips">
      <ListRow
        title="My payslips"
        detail="Salary and monthly payslips"
        onPress={() => router.push('/home/my-payslips')}
        testID="home.myPayslips.open"
      />
    </Sheet>
  );
}

export function MyPayslipsScreen() {
  const online = useOnline();
  const client = useQueryClient();
  const session = useSession();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<PayslipDto | null>(null);
  const salary = useQuery({ queryKey: payslipKeys.salary, queryFn: fetchSalary, enabled: online });
  const payslips = useQuery({ queryKey: payslipKeys.list(page), queryFn: () => fetchPayslips(page), enabled: online });

  if (!online) {
    return (
      <Screen title="My payslips" testID="myPayslips.screen">
        <EmptyState title="Needs a connection" description="Payslips are read online only. Connect and open this again." />
      </Screen>
    );
  }

  const current = salary.data?.current ?? null;
  return (
    <Screen title="My payslips" testID="myPayslips.screen" onRefresh={() => void client.invalidateQueries({ queryKey: payslipKeys.all })}>
      <Text style={styles.heading}>Salary</Text>
      {salary.isPending ? (
        <LoadingState />
      ) : salary.isError ? (
        <ErrorState error={salary.error} onRetry={() => void salary.refetch()} />
      ) : current === null ? (
        <EmptyState title="No salary recorded" description="The office records your salary." />
      ) : (
        <Sheet testID="myPayslips.salary">
          <ListRow title="Basic" value={formatRupees(current.basic)} />
          {current.components.map((c) => (
            <ListRow
              key={`${c.kind}-${c.name}`}
              title={c.name}
              value={c.kind === 'deduction' ? `-${formatRupees(c.amount)}` : formatRupees(c.amount)}
            />
          ))}
          {salary.data.upcoming ? (
            <ListRow
              title={`From ${formatDay(salary.data.upcoming.effectiveFrom)}`}
              detail="A change is recorded"
              value={formatRupees(salary.data.upcoming.basic)}
            />
          ) : null}
        </Sheet>
      )}
      <Text style={styles.heading}>Payslips</Text>
      {payslips.isPending ? (
        <LoadingState />
      ) : payslips.isError ? (
        <ErrorState error={payslips.error} onRetry={() => void payslips.refetch()} />
      ) : payslips.data.data.length === 0 ? (
        <EmptyState title="No payslips yet" description="A payslip appears here once its month's payroll is finalised." />
      ) : (
        <>
          <Sheet testID="myPayslips.list">
            {payslips.data.data.map((slip) => (
              <ListRow
                key={slip.id}
                title={monthLabel(slip.yearMonth)}
                detail={paidLine(slip)}
                value={formatRupees(slip.net)}
                onPress={() => setOpen(slip)}
                testID={`myPayslips.slip.${slip.id}`}
              />
            ))}
          </Sheet>
          <Paging page={page} limit={PAYSLIP_LIMIT} total={payslips.data.total} onPage={setPage} testID="myPayslips.paging" />
        </>
      )}
      {open ? (
        <ModalSheet
          visible
          title={`Payslip, ${monthLabel(open.yearMonth)}`}
          onClose={() => setOpen(null)}
          testID="myPayslips.detail"
          footer={
            <Button
              label="Share"
              onPress={() => void Share.share({ message: payslipText(open, session.me?.body.school.name ?? '') })}
              testID="myPayslips.share"
            />
          }
        >
          {payslipRows(open).map((row, i) => (
            <View key={`${i}-${row.label}`} style={styles.row}>
              <Text style={styles.label}>{row.label}</Text>
              <Text style={styles.amount}>{row.amount}</Text>
            </View>
          ))}
          {open.deductionsNotTaken.map((d) => (
            <Text key={d.name} style={styles.note}>
              {d.name}: {formatRupees(d.amount)} not deducted this month
            </Text>
          ))}
          <Text style={styles.note}>
            Unpaid days: {open.unpaidDays}. {paidLine(open)}.
          </Text>
        </ModalSheet>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  heading: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground, marginTop: space.md },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: space.md, paddingVertical: space.xs },
  label: { flex: 1, fontSize: fontSize.body, color: colors.foreground },
  amount: { fontSize: fontSize.body, color: colors.foreground, fontVariant: ['tabular-nums'] },
  note: { fontSize: fontSize.small, color: colors.mutedForeground, marginTop: space.sm },
});
