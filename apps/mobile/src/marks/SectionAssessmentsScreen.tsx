import { Capability, formatDay } from '@asms/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { AssessmentDto, MeDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { holds, schoolWide } from '../auth/capabilities';
import { useSession } from '../auth/session';
import { discardItem } from '../db/local.repository';
import { listLocalAssessments, type LocalAssessment } from '../db/local-marks.repository';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { remedyFor } from '../outbox/lanes';
import { outboxWorker, useLocalQuery } from '../outbox/runtime';
import { Button } from '../ui/Button';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { localState, StateLine } from '../ui/StateLine';
import { cachedOfflineBanner, EmptyState, NoDataState } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize, space } from '../ui/theme';

// A section's tests and exams — /marks/[sectionId] (plan §3.8): the server's list (cached, so it
// reads offline) and, above it, the tests made on this phone and not yet answered, each with its
// state line. "New test" for a subject the caller teaches there. No child's name: not secure.

type Page = { data: AssessmentDto[] };

/** The subjects (subjects.id) the caller enters marks for on the section: their own, or every one school-wide. */
export function markSubjects(
  me: Pick<MeDto, 'assignments' | 'capabilities' | 'capabilityScopes'>,
  sectionId: string,
  classId: string | null,
): string[] | 'all' {
  if (!holds(me, Capability.MARKS_ENTER)) return [];
  if (schoolWide(me, Capability.MARKS_ENTER)) return 'all';
  return [
    ...new Set(
      me.assignments
        .filter((a) => a.role === 'subject_teacher' && a.subjectId !== null)
        .filter((a) => a.sectionId === sectionId || (a.sectionId === null && a.classId === classId))
        .map((a) => a.subjectId!),
    ),
  ];
}

/**
 * The academic year of the caller's class-teacher or cover assignment on the section, or null
 * when they hold neither (only the class teacher, or cover, opens the sheet on the phone).
 */
export function sheetYearOf(me: Pick<MeDto, 'assignments'>, sectionId: string): string | null {
  const a = me.assignments.find((x) => x.sectionId === sectionId && (x.role === 'class_teacher' || x.role === 'cover'));
  return a?.academicYearId ?? null;
}

const kindLine = (a: Pick<AssessmentDto, 'kind' | 'testType'>) =>
  a.kind === 'exam'
    ? 'Exam'
    : `${(a.testType ?? 'other').replace(/^./, (c) => c.toUpperCase())} test`;

export function SectionAssessmentsScreen({
  sectionId,
  classId,
}: {
  sectionId: string;
  classId: string | null;
}) {
  const router = useRouter();
  const online = useOnline();
  const { me } = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const params = { sectionId, limit: 50 };
  const list = useCachedQuery<Page>(
    queryKeys.assessments(sectionId),
    '/api/v1/assessments',
    params,
    () => unwrapWithDate(api.GET('/api/v1/assessments', { params: { query: params } })),
  );
  const local = useLocalQuery(queryKeys.localAssessments(sectionId), () =>
    listLocalAssessments(sectionId),
  );
  const subjects = me ? markSubjects(me.body, sectionId, classId) : [];
  // Slice 31: the class teacher (or cover) opens the section's result sheet from here.
  const sheetYearId = me ? sheetYearOf(me.body, sectionId) : null;
  const mayCreate = subjects === 'all' || subjects.length > 0;
  const tests = list.data?.body.data ?? [];
  const mine = local.data ?? [];

  const open = (id: string, isLocal: boolean) =>
    router.push({
      pathname: '/marks/test/[id]',
      params: { id, ...(isLocal ? { local: '1' } : {}) },
    });

  return (
    <Screen
      title="Tests and exams"
      accessory={<SyncChip />}
      banner={cachedOfflineBanner(list.data, online, list.isError)}
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void list.refetch().finally(() => setRefreshing(false));
      }}
      footer={
        mayCreate || sheetYearId !== null ? (
          <View style={styles.actions}>
            {mayCreate ? (
              <Button
                label="New test"
                onPress={() =>
                  router.push({
                    pathname: '/marks/[sectionId]/new',
                    params: { sectionId, ...(classId ? { classId } : {}) },
                  })
                }
                testID="marks.new"
              />
            ) : null}
            {sheetYearId !== null ? (
              <Button
                label="Result sheet"
                variant="secondary"
                onPress={() =>
                  router.push({ pathname: '/marks/[sectionId]/sheet', params: { sectionId, yearId: sheetYearId } })
                }
                testID="marks.resultSheet"
              />
            ) : null}
          </View>
        ) : null
      }
      testID="marks.section.screen"
    >
      {mine.length > 0 ? (
        <Sheet title="On this phone">
          {mine.map((test) => (
            <LocalTestRow
              key={test.id}
              test={test}
              onOpen={() => open(test.id, true)}
              onResend={() =>
                router.push({
                  pathname: '/marks/[sectionId]/new',
                  params: { sectionId, resend: test.id, ...(classId ? { classId } : {}) },
                })
              }
            />
          ))}
        </Sheet>
      ) : null}
      {list.data === undefined ? (
        <NoDataState
          isError={list.isError}
          error={list.error}
          onRetry={() => void list.refetch()}
          offlineMessage="This section's tests are not on this phone yet. Open them once while connected."
        />
      ) : tests.length === 0 && mine.length === 0 ? (
        <EmptyState
          title="No tests yet"
          description={mayCreate ? 'Create a class test to enter its marks.' : undefined}
        />
      ) : (
        <Sheet>
          {tests.map((test) => (
            <ListRow
              key={test.id}
              title={test.name}
              detail={`${formatDay(test.heldOn)} · ${test.subjectName} · ${kindLine(test)}`}
              value={`${test.markedCount} marked`}
              onPress={() => open(test.id, false)}
              testID={`marks.test.${test.id}`}
            />
          ))}
        </Sheet>
      )}
    </Screen>
  );
}

function LocalTestRow({
  test,
  onOpen,
  onResend,
}: {
  test: LocalAssessment;
  onOpen: () => void;
  onResend: () => void;
}) {
  const state = localState(test.outbox, test.savedOnServerAt);
  const remedy =
    test.outbox?.state === 'failed'
      ? remedyFor('assessment_create', test.outbox.responseCode)
      : null;
  return (
    <View style={styles.local} testID={`marks.localTest.${test.id}`}>
      <ListRow
        title={test.name}
        detail={`${formatDay(test.heldOn)} · out of ${test.maxMarks}`}
        onPress={onOpen}
      />
      <StateLine state={state} testID={`marks.localTest.${test.id}.state`} />
      {remedy !== null ? (
        <View style={styles.actions}>
          {remedy === 'edit_resend' ? (
            <Button label="Edit and resend" variant="secondary" onPress={onResend} />
          ) : null}
          <Button
            label="Discard"
            variant="destructive"
            onPress={() => {
              if (test.outbox)
                void discardItem(test.outbox.id).then(() => outboxWorker.trigger('enqueued'));
            }}
          />
        </View>
      ) : null}
      {test.outbox?.state === 'failed' ? (
        <Text style={styles.caption}>Marks typed on it are kept until you discard it.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  local: { gap: space.xs, paddingBottom: space.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
