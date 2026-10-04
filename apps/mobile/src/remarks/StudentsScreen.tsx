import { todayInSchool } from '@asms/shared';
import { useRouter } from 'expo-router';
import { api, unwrapWithDate } from '../api/client';
import type { RegisterViewDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnline } from '../net/connectivity';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, NoDataState, OfflineNotice } from '../ui/states';

// A section's students — /classes/[sectionId]/students (slice-16 §4.1, §4.6): the roster of
// today's register view (period 1), the same cached row the register uses. Children's names:
// secure.

/** Today's register view of a section, period 1: the roster the students list and sheet read. */
export function useTodayRoster(sectionId: string) {
  const date = todayInSchool();
  return useCachedQuery<RegisterViewDto>(
    queryKeys.register(sectionId, date, 1),
    `/api/v1/sections/${sectionId}/register`,
    { date, period: 1 },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/sections/{id}/register', {
          params: { path: { id: sectionId }, query: { date, period: 1 } },
        }),
      ),
  );
}

export function StudentsScreen({ sectionId, secure }: { sectionId: string; secure?: boolean }) {
  const router = useRouter();
  const online = useOnline();
  const roster = useTodayRoster(sectionId);
  const cached = roster.data;
  return (
    <Screen
      title="Students"
      secure={secure}
      banner={
        cached !== undefined && (!online || roster.isError) ? (
          <OfflineNotice serverTime={cached.serverTime} isDevice={cached.serverTimeIsDevice} />
        ) : null
      }
      testID="students.screen"
    >
      {cached === undefined ? (
        <NoDataState
          isError={roster.isError}
          error={roster.error}
          onRetry={() => void roster.refetch()}
          offlineMessage="The class list is not on this phone yet. Open it once while connected."
        />
      ) : cached.body.roster.length === 0 ? (
        <EmptyState title="No students in this section." />
      ) : (
        <Sheet title={`${cached.body.section.className} ${cached.body.section.name}`}>
          {cached.body.roster
            .filter((row) => row.onRoster)
            .map((row) => (
              <ListRow
                key={row.studentId}
                title={row.studentFullName}
                detail={row.rollNo === null ? null : `Roll ${row.rollNo}`}
                onPress={() =>
                  router.push({
                    pathname: '/classes/[sectionId]/students/[studentId]',
                    params: { sectionId, studentId: row.studentId },
                  })
                }
                testID={`students.row.${row.studentId}`}
              />
            ))}
        </Sheet>
      )}
    </Screen>
  );
}
