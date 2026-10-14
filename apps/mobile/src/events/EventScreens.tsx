import {
  EVENT_TYPE_LABELS,
  formatDay,
  formatRupees,
  newIdempotencyKey,
  todayInSchool,
  type ParticipationStatus,
} from '@asms/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrap } from '../api/client';
import type {
  EventDto,
  EventRosterDto,
  EventRosterRowDto,
  MyEventDto,
  PaymentDto,
} from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import type { FamilySource } from '../family/source';
import { useOnline, useOnlineOnly } from '../net/connectivity';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import {
  amountProblem,
  canCollect,
  chargeLine,
  changedRows,
  DUTY_LABELS,
  eventValue,
  eventWhen,
  eventWriteFailure,
  myChargeLine,
  PARTICIPATION_LABELS,
  rosterDetail,
  rupeeDigits,
} from './events';

// Events on the phone (Phase 5 slice 38, contracts/slice-38.md §6, plan §3.7): the teacher's
// Classes → Events (their duties and their classes' events, the roster's participation, and on a
// collection duty the event's cash payments), and a family's list. Online only and never cached
// on the phone: no outbox lane. The event screen names children (the roster): secure.

type Page<T> = { data: T[]; total: number; page: number; limit: number };

const PARTICIPATION_OPTIONS = (['attended', 'absent', 'excused'] as const).map((value) => ({
  value,
  label: PARTICIPATION_LABELS[value],
}));

function NeedsConnection({ title, testID }: { title: string; testID: string }) {
  return (
    <Screen title={title} testID={testID}>
      <EmptyState title="Needs a connection" description="Events are read online only." />
    </Screen>
  );
}

/** Classes → Events: `GET /events?mine=true`, newest first. Names no child: not secure. */
export function StaffEventsScreen() {
  const router = useRouter();
  const online = useOnline();
  const query = useQuery({
    queryKey: queryKeys.staffEvents,
    queryFn: (): Promise<Page<EventDto>> =>
      unwrap(api.GET('/api/v1/events', { params: { query: { mine: true, limit: 50, page: 1 } } })),
    enabled: online,
  });
  if (!online) return <NeedsConnection title="Events" testID="events.screen" />;
  const data = query.data;
  return (
    <Screen
      title="Events"
      testID="events.screen"
      refreshing={query.isRefetching}
      onRefresh={() => void query.refetch()}
    >
      {query.isPending ? (
        <LoadingState />
      ) : query.isError || data === undefined ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : data.data.length === 0 ? (
        <EmptyState
          title="No events for you"
          description="Events where you have a duty, or that your classes take part in, appear here."
        />
      ) : (
        <Sheet testID="events.list">
          {data.data.map((e) => (
            <ListRow
              key={e.id}
              title={e.title}
              detail={`${EVENT_TYPE_LABELS[e.type]} · ${eventWhen(e)}`}
              value={eventValue(e)}
              onPress={() =>
                router.push({ pathname: '/classes/events/[id]', params: { id: e.id } })
              }
              testID={`events.row.${e.id}`}
            />
          ))}
        </Sheet>
      )}
    </Screen>
  );
}

/** One event: its details, the caller's duties, the roster's participation and the collection. */
export function StaffEventScreen({ id, secure }: { id: string; secure?: boolean }) {
  const online = useOnline();
  const client = useQueryClient();
  const event = useQuery({
    queryKey: queryKeys.event(id),
    queryFn: (): Promise<EventDto> =>
      unwrap(api.GET('/api/v1/events/{id}', { params: { path: { id } } })),
    enabled: online,
  });
  const roster = useQuery({
    queryKey: queryKeys.eventRoster(id),
    queryFn: (): Promise<EventRosterDto> =>
      unwrap(api.GET('/api/v1/events/{id}/participation', { params: { path: { id } } })),
    enabled: online,
  });
  const collecting = event.data !== undefined && canCollect(event.data);
  const payments = useQuery({
    queryKey: queryKeys.eventPayments(id),
    queryFn: (): Promise<Page<PaymentDto>> =>
      unwrap(
        api.GET('/api/v1/events/{id}/payments', {
          params: { path: { id }, query: { limit: 50, page: 1 } },
        }),
      ),
    enabled: online && collecting,
  });
  const [message, setMessage] = useState<string | null>(null);
  const [collect, setCollect] = useState<EventRosterRowDto | null>(null);

  if (!online) return <NeedsConnection title="Event" testID="event.screen" />;
  const refresh = () => void client.invalidateQueries({ queryKey: queryKeys.event(id) });
  const e = event.data;
  return (
    <Screen
      title={e?.title ?? 'Event'}
      secure={secure}
      testID="event.screen"
      refreshing={event.isRefetching || roster.isRefetching}
      onRefresh={refresh}
    >
      {message !== null ? (
        <Text style={styles.message} testID="event.message">
          {message}
        </Text>
      ) : null}
      {event.isPending ? (
        <LoadingState />
      ) : event.isError || e === undefined ? (
        <ErrorState error={event.error} onRetry={() => void event.refetch()} />
      ) : (
        <>
          <EventDetails event={e} />
          <Text style={styles.heading}>Participation</Text>
          {roster.isPending ? (
            <LoadingState />
          ) : roster.isError || roster.data === undefined ? (
            <ErrorState error={roster.error} onRetry={() => void roster.refetch()} />
          ) : (
            <Participation
              event={e}
              roster={roster.data}
              collecting={collecting}
              onCollect={(row) => {
                setMessage(null);
                setCollect(row);
              }}
              onSaved={(next) => {
                client.setQueryData(queryKeys.eventRoster(id), next);
                setMessage('Participation saved.');
              }}
              onStale={refresh}
            />
          )}
          {collecting ? <Payments query={payments} /> : null}
          {collect !== null ? (
            <CollectSheet
              eventId={e.id}
              row={collect}
              onClose={() => setCollect(null)}
              onRecorded={(text) => {
                setCollect(null);
                setMessage(text);
                refresh();
              }}
              onStale={refresh}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function EventDetails({ event: e }: { event: EventDto }) {
  const duties = e.myDuties.map((d) => DUTY_LABELS[d]).join(', ');
  return (
    <Sheet testID="event.details">
      <View style={styles.block}>
        <Text style={styles.caption}>{EVENT_TYPE_LABELS[e.type]}</Text>
        <Text style={styles.body} testID="event.when">
          {eventWhen(e)}
        </Text>
        <Text style={styles.body}>{e.venue}</Text>
        {e.details ? <Text style={styles.body}>{e.details}</Text> : null}
        {e.charge !== null ? (
          <Text style={styles.body} testID="event.charge">
            {`Charge: ${formatRupees(e.charge.amount)} a student, due ${formatDay(e.charge.dueOn)}`}
          </Text>
        ) : null}
        <Text style={styles.body} testID="event.duties">
          {duties === '' ? 'Your classes take part.' : `Your duties: ${duties}`}
        </Text>
        {e.status === 'completed' ? (
          <Text style={styles.caption}>Completed: participation is closed.</Text>
        ) : e.status === 'cancelled' ? (
          <Text
            style={styles.caption}
          >{`Cancelled${e.cancelReason ? `: ${e.cancelReason}` : '.'}`}</Text>
        ) : null}
      </View>
    </Sheet>
  );
}

/** The roster: a status per student while published, read-only afterwards; Save sends changes. */
function Participation({
  event,
  roster,
  collecting,
  onCollect,
  onSaved,
  onStale,
}: {
  event: EventDto;
  roster: EventRosterDto;
  collecting: boolean;
  onCollect: (row: EventRosterRowDto) => void;
  onSaved: (roster: EventRosterDto) => void;
  onStale: () => void;
}) {
  const gate = useOnlineOnly('record_event_participation');
  const [draft, setDraft] = useState<Record<string, ParticipationStatus>>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const open = roster.status === 'published';
  const changes = changedRows(roster.rows, draft);

  if (roster.rows.length === 0) {
    return <EmptyState title="No students on this event's roster" />;
  }
  const save = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await unwrap(
        api.POST('/api/v1/events/{id}/record-participation', {
          params: { path: { id: event.id } },
          body: { rows: changes },
        }),
      );
      setDraft({});
      onSaved(next);
    } catch (error) {
      const outcome = eventWriteFailure(error);
      // A refusal means the event or the roster moved on: read both again.
      if (outcome.definite) onStale();
      setFailure(outcome.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Sheet testID="event.roster">
        {roster.rows.map((row) => {
          const owed = row.charge !== null && row.charge.outstanding > 0;
          return (
            <View key={row.studentId} style={styles.row} testID={`event.row.${row.studentId}`}>
              {open ? (
                <SegmentedPicker
                  label={row.fullName}
                  options={PARTICIPATION_OPTIONS}
                  value={draft[row.studentId] ?? row.participation}
                  onChange={(status) => setDraft({ ...draft, [row.studentId]: status })}
                  disabled={!gate.enabled || busy}
                  testID={`event.row.${row.studentId}.status`}
                />
              ) : (
                <ListRow
                  title={row.fullName}
                  value={
                    row.participation ? PARTICIPATION_LABELS[row.participation] : 'Not recorded'
                  }
                />
              )}
              <Text style={styles.caption}>
                {[rosterDetail(row), chargeLine(row.charge)].filter(Boolean).join(' · ')}
              </Text>
              {collecting && owed ? (
                <Button
                  label={`Collect ${formatRupees(row.charge!.outstanding)}`}
                  variant="secondary"
                  onPress={() => onCollect(row)}
                  disabled={!gate.enabled}
                  testID={`event.row.${row.studentId}.collect`}
                />
              ) : null}
            </View>
          );
        })}
      </Sheet>
      {open ? (
        <View style={styles.block}>
          {failure !== null ? (
            <Text style={styles.error} testID="event.save.failure">
              {failure}
            </Text>
          ) : null}
          {gate.reason ? <Text style={styles.caption}>{gate.reason}</Text> : null}
          <Button
            label={
              changes.length === 0
                ? 'Save participation'
                : `Save participation (${changes.length} changed)`
            }
            onPress={() => void save()}
            disabled={!gate.enabled || changes.length === 0}
            busy={busy}
            testID="event.save"
          />
        </View>
      ) : null}
    </>
  );
}

/** The collector's own event payments (the API returns only theirs without payment.record). */
function Payments({
  query,
}: {
  query: {
    data: Page<PaymentDto> | undefined;
    isPending: boolean;
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
}) {
  return (
    <>
      <Text style={styles.heading}>Payments collected</Text>
      {query.isPending ? (
        <LoadingState />
      ) : query.isError || query.data === undefined ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.data.length === 0 ? (
        <EmptyState title="No payments collected yet" />
      ) : (
        <Sheet testID="event.payments">
          {query.data.data.map((p) => (
            <ListRow
              key={p.id}
              title={p.students.map((s) => s.fullName).join(', ') || p.payerName}
              detail={[p.receipt?.receiptLabel, formatDay(p.receivedOn)]
                .filter(Boolean)
                .join(' · ')}
              value={p.status === 'voided' ? 'Voided' : formatRupees(p.amount)}
              testID={`event.payment.${p.id}`}
            />
          ))}
        </Sheet>
      )}
      <Text style={styles.caption}>Hand the cash you collect to the office.</Text>
    </>
  );
}

/** Records one student's cash for the event's charge (§2.7): at most what is owed, today. */
function CollectSheet({
  eventId,
  row,
  onClose,
  onRecorded,
  onStale,
}: {
  eventId: string;
  row: EventRosterRowDto;
  onClose: () => void;
  onRecorded: (message: string) => void;
  onStale: () => void;
}) {
  const gate = useOnlineOnly('record_event_payment');
  const outstanding = row.charge?.outstanding ?? 0;
  // Made once per open of the sheet, and anew after a refusal: a changed body is a new key.
  const [key, setKey] = useState(newIdempotencyKey);
  const [amount, setAmount] = useState(String(outstanding));
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = amountProblem(amount, outstanding);

  const send = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const payment = await unwrap(
        api.POST('/api/v1/events/{id}/payments', {
          params: { path: { id: eventId }, header: { 'Idempotency-Key': key } },
          body: {
            studentId: row.studentId,
            amount: Number(amount),
            receivedOn: todayInSchool(),
            ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
          },
        }),
      );
      const receipt = payment.receipt ? `Receipt ${payment.receipt.receiptLabel}: ` : '';
      onRecorded(`${receipt}${formatRupees(payment.amount)} from ${row.fullName} recorded.`);
    } catch (error) {
      const outcome = eventWriteFailure(error);
      if (outcome.definite) {
        setKey(newIdempotencyKey());
        onStale();
      }
      setFailure(outcome.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalSheet
      visible
      title="Collect for the event"
      onClose={onClose}
      testID="event.collectSheet"
      footer={
        <>
          {failure !== null ? (
            <Text style={styles.error} testID="event.collect.failure">
              {failure}
            </Text>
          ) : null}
          {gate.reason ? <Text style={styles.caption}>{gate.reason}</Text> : null}
          <Button
            label="Record cash"
            onPress={() => void send()}
            disabled={!gate.enabled || problem !== null}
            busy={busy}
            testID="event.collect.save"
          />
        </>
      }
    >
      <Text style={styles.body}>{row.fullName}</Text>
      <Text style={styles.caption}>{`${rosterDetail(row)} · ${chargeLine(row.charge)}`}</Text>
      <Field
        label="Cash received (Rs)"
        value={amount}
        onChangeText={(text) => setAmount(rupeeDigits(text))}
        keyboardType="number-pad"
        error={problem}
        testID="event.collect.amount"
      />
      <Field
        label="Receipt book or note (optional)"
        value={reference}
        onChangeText={setReference}
        maxLength={64}
        testID="event.collect.reference"
      />
    </ModalSheet>
  );
}

/** A child's (or the student's own) events: details and the child's own charge. Read-only. */
export function FamilyEventsScreen({ source }: { source: FamilySource }) {
  const online = useOnline();
  const studentId = source.kind === 'child' ? source.studentId : null;
  const query = useQuery({
    queryKey: queryKeys.familyEvents(studentId),
    queryFn: (): Promise<Page<MyEventDto>> => {
      const query = { limit: 50, page: 1 };
      return source.kind === 'child'
        ? unwrap(
            api.GET('/api/v1/me/children/{id}/events', {
              params: { path: { id: source.studentId }, query },
            }),
          )
        : unwrap(api.GET('/api/v1/me/student/events', { params: { query } }));
    },
    enabled: online,
  });
  if (!online) return <NeedsConnection title="Events" testID="familyEvents.screen" />;
  const data = query.data;
  return (
    <Screen
      title="Events"
      testID="familyEvents.screen"
      refreshing={query.isRefetching}
      onRefresh={() => void query.refetch()}
    >
      {query.isPending ? (
        <LoadingState />
      ) : query.isError || data === undefined ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : data.data.length === 0 ? (
        <EmptyState
          title="No events yet"
          description="Meetings, trips and functions the class is invited to appear here."
        />
      ) : (
        data.data.map((e) => (
          <Sheet key={e.id} testID={`familyEvents.event.${e.id}`}>
            <View style={styles.block}>
              <Text style={styles.title}>{e.title}</Text>
              <Text style={styles.caption}>
                {e.status === 'completed'
                  ? `${EVENT_TYPE_LABELS[e.type]} · Held`
                  : EVENT_TYPE_LABELS[e.type]}
              </Text>
              <Text style={styles.body}>{eventWhen(e)}</Text>
              <Text style={styles.body}>{e.venue}</Text>
              {e.details ? <Text style={styles.body}>{e.details}</Text> : null}
              {e.charge !== null ? (
                <Text style={styles.body} testID={`familyEvents.event.${e.id}.charge`}>
                  {myChargeLine(e)}
                </Text>
              ) : null}
            </View>
          </Sheet>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.xs, paddingVertical: space.sm },
  row: { gap: space.xs, paddingVertical: space.sm },
  heading: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  title: { fontSize: fontSize.body, fontWeight: '600', color: colors.foreground },
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  message: { fontSize: fontSize.body, color: colors.foreground },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
