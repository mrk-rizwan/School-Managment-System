import { formatDay, formatPercentLabel, formatRupees, resultTermLabel } from '@asms/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrap } from '../api/client';
import type {
  MyAssessmentMarkDto,
  MyChildResultsDto,
  MyResultDto,
  MyResultSummaryDto,
} from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import { useOnline } from '../net/connectivity';
import { ReportCardView } from '../results/ReportCardView';
import { Button } from '../ui/Button';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import type { FamilySource } from './source';

// Results for a parent's child and for the student (phase-4-academic.md slice 33, contracts/
// slice-33.md §5): the year's published terms and final, the report card (slice 32's
// ReportCardView, shared as text), and the class tests as entered (a page at a time). Online only and never
// cached on the phone: withholding for dues is decided at read time (R282) and a correction
// replaces a card (R280), so a stored copy could show what the school no longer serves. Secure:
// a child's name and marks.

const studentIdOf = (source: FamilySource): string | null =>
  source.kind === 'child' ? source.studentId : null;

const summaryLine = (s: MyResultSummaryDto): string =>
  [formatPercentLabel(s.percentBp), s.grade, s.revised ? 'Revised' : null].filter(Boolean).join(' · ');

const testLine = (t: MyAssessmentMarkDto): string =>
  t.absent ? (t.excused ? 'Excused' : 'Absent') : `${t.obtained ?? 0} / ${t.maxMarks}`;

function fetchResults(source: FamilySource, yearId: string | null): Promise<MyChildResultsDto> {
  const query = yearId === null ? {} : { academicYearId: yearId };
  return source.kind === 'child'
    ? unwrap(
        api.GET('/api/v1/me/children/{id}/results', {
          params: { path: { id: source.studentId }, query },
        }),
      )
    : unwrap(api.GET('/api/v1/me/student/results', { params: { query } }));
}

function fetchCard(source: FamilySource, resultId: string): Promise<MyResultDto> {
  return source.kind === 'child'
    ? unwrap(
        api.GET('/api/v1/me/children/{id}/results/{resultId}', {
          params: { path: { id: source.studentId, resultId } },
        }),
      )
    : unwrap(
        api.GET('/api/v1/me/student/results/{resultId}', { params: { path: { resultId } } }),
      );
}

const TESTS_LIMIT = 25;

function fetchTests(source: FamilySource, page: number) {
  const query = { page, limit: TESTS_LIMIT };
  return source.kind === 'child'
    ? unwrap(
        api.GET('/api/v1/me/children/{id}/assessments', {
          params: { path: { id: source.studentId }, query },
        }),
      )
    : unwrap(api.GET('/api/v1/me/student/assessments', { params: { query } }));
}

/** The header: the child's name from /me, or the student's own. */
function useName(source: FamilySource): string {
  const { me } = useSession();
  if (me === null) return '';
  if (source.kind === 'own') return me.body.fullName;
  return me.body.children.find((c) => c.studentId === source.studentId)?.fullName ?? '';
}

function Withheld({ source, outstanding }: { source: FamilySource; outstanding: number | null }) {
  // Security L3: the student is never told why (no mention of fees); the family is.
  if (source.kind === 'own') {
    return (
      <Sheet testID="results.withheld">
        <Text style={styles.body}>Report card not available.</Text>
        <Text style={styles.caption}>Please ask your parent or the school office.</Text>
      </Sheet>
    );
  }
  return (
    <Sheet testID="results.withheld">
      <Text style={styles.body}>The report card is held back for unpaid fees.</Text>
      <Text style={styles.caption}>
        {outstanding !== null
          ? `${formatRupees(outstanding)} is owed. Pay at the school office to see the full card.`
          : 'The full card shows here once the school says the fees are cleared.'}
      </Text>
    </Sheet>
  );
}

/** /children/[studentId]/results and /student/results. */
export function FamilyResultsScreen({ source, secure }: { source: FamilySource; secure?: boolean }) {
  const router = useRouter();
  const online = useOnline();
  const name = useName(source);
  const [yearId, setYearId] = useState<string | null>(null);
  const studentId = studentIdOf(source);
  const results = useQuery({
    queryKey: queryKeys.familyResults(studentId, 'list', yearId ?? ''),
    queryFn: () => fetchResults(source, yearId),
    enabled: online,
  });
  // Newest first, a page at a time: "Load older" appends the next page (contracts/slice-33.md §5).
  const tests = useInfiniteQuery({
    queryKey: queryKeys.familyResults(studentId, 'tests'),
    queryFn: ({ pageParam }) => fetchTests(source, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last, all) =>
      all.reduce((n, p) => n + p.data.length, 0) < last.total && last.data.length > 0
        ? all.length + 1
        : undefined,
    enabled: online,
  });
  const testRows = tests.data?.pages.flatMap((p) => p.data) ?? [];
  const openCard = (resultId: string) =>
    router.push(
      source.kind === 'child'
        ? {
            pathname: '/children/[studentId]/results/[resultId]',
            params: { studentId: source.studentId, resultId },
          }
        : { pathname: '/student/results/[resultId]', params: { resultId } },
    );

  if (!online) {
    return (
      <Screen title={name} secure={secure} testID="results.screen">
        <EmptyState title="Needs a connection" description="Results are read online only." />
      </Screen>
    );
  }
  const data = results.data;
  const summaries = data ? [...data.terms, ...(data.final ? [data.final] : [])] : [];
  const years = data?.years ?? [];
  const yearIndex = years.findIndex((y) => y.id === data?.academicYearId);
  return (
    <Screen title={name} secure={secure} testID="results.screen">
      {results.isPending ? (
        <LoadingState />
      ) : results.isError ? (
        <ErrorState error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <>
          {years.length > 1 ? (
            <View style={styles.years}>
              <Button
                label="Older year"
                variant="secondary"
                disabled={yearIndex < 0 || yearIndex >= years.length - 1}
                onPress={() => setYearId(years[yearIndex + 1]?.id ?? null)}
                testID="results.olderYear"
              />
              <Button
                label="Newer year"
                variant="secondary"
                disabled={yearIndex <= 0}
                onPress={() => setYearId(years[yearIndex - 1]?.id ?? null)}
                testID="results.newerYear"
              />
            </View>
          ) : null}
          {data?.withheld ? <Withheld source={source} outstanding={data.outstanding} /> : null}
          {summaries.length === 0 ? (
            <EmptyState
              title="No results published yet"
              description="A term result appears here once the school publishes it."
            />
          ) : (
            <Sheet title={years[yearIndex]?.name ?? 'Results'}>
              {summaries.map((s) => (
                <ListRow
                  key={s.id}
                  title={resultTermLabel(s)}
                  detail={summaryLine(s)}
                  onPress={() => openCard(s.id)}
                  testID={`results.summary.${s.id}`}
                />
              ))}
            </Sheet>
          )}
        </>
      )}
      <Sheet title="Class tests">
        {tests.isPending ? (
          <LoadingState />
        ) : tests.isError ? (
          <ErrorState error={tests.error} onRetry={() => void tests.refetch()} />
        ) : testRows.length === 0 ? (
          <Text style={styles.caption}>No class test has been marked yet.</Text>
        ) : (
          <>
            {testRows.map((t) => (
              <ListRow
                key={t.markId}
                title={`${t.subjectName} · ${t.name}`}
                detail={`${formatDay(t.heldOn)} · ${t.termName}`}
                value={testLine(t)}
                testID={`results.test.${t.assessmentId}`}
              />
            ))}
            {tests.hasNextPage ? (
              <Button
                label={tests.isFetchingNextPage ? 'Loading…' : 'Load older'}
                variant="secondary"
                disabled={tests.isFetchingNextPage}
                onPress={() => void tests.fetchNextPage()}
                testID="results.loadOlder"
              />
            ) : null}
          </>
        )}
      </Sheet>
    </Screen>
  );
}

/** /children/[studentId]/results/[resultId] and /student/results/[resultId]: the card. */
export function FamilyResultCardScreen({
  source,
  resultId,
  secure,
}: {
  source: FamilySource;
  resultId: string;
  secure?: boolean;
}) {
  const online = useOnline();
  const name = useName(source);
  const card = useQuery({
    queryKey: queryKeys.familyResults(studentIdOf(source), 'card', resultId),
    queryFn: () => fetchCard(source, resultId),
    enabled: online,
  });
  return (
    <Screen title={name} secure={secure} testID="resultCard.screen">
      {!online ? (
        <EmptyState title="Needs a connection" description="Results are read online only." />
      ) : card.isPending ? (
        <LoadingState />
      ) : card.isError ? (
        <ErrorState error={card.error} onRetry={() => void card.refetch()} />
      ) : card.data.result === null ? (
        <Withheld source={source} outstanding={card.data.outstanding} />
      ) : (
        <ReportCardView result={card.data.result} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: fontSize.body, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground, marginTop: space.xs },
  years: { flexDirection: 'row', gap: space.sm },
});
