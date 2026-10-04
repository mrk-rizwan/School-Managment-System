import { todayInSchool } from '@asms/shared';
import { useQueries } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { SectionDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import { cacheKey, readCache, writeCache, type Cached } from '../db/cache';
import { useOnline } from '../net/connectivity';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, LoadingState, OfflineNotice } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize } from '../ui/theme';
import { actionsFor, groupAssignments, sectionTitle, wholeClassIds } from './my-classes';

// My classes — /classes (slice-16 §4.1). Not secure: no child's name is on it.

type SectionsPage = { data: SectionDto[] };

/** A class's sections for its whole-class subject rows: cached, 50 a page (a picker read). */
function useClassSections(classIds: readonly string[]) {
  return useQueries({
    queries: classIds.map((classId) => {
      const path = '/api/v1/classes/{id}/sections';
      const key = cacheKey(`/api/v1/classes/${classId}/sections`, { limit: 50 });
      return {
        queryKey: queryKeys.classSections(classId),
        queryFn: async (): Promise<Cached<SectionsPage>> => {
          try {
            const { data, date } = await unwrapWithDate(
              api.GET(path, { params: { path: { id: classId }, query: { limit: 50 } } }),
            );
            return await writeCache(key, data, date);
          } catch (error) {
            const cached = await readCache<SectionsPage>(key);
            if (cached !== null) return cached;
            throw error;
          }
        },
      };
    }),
  });
}

export function MyClassesScreen() {
  const router = useRouter();
  const online = useOnline();
  const session = useSession();
  const [refreshing, setRefreshing] = useState(false);
  const me = session.me;
  const classIds = me ? wholeClassIds(me.body.assignments) : [];
  const sections = useClassSections(classIds);
  if (me === null) return <LoadingState />;

  const sectionsOf = (classId: string) => sections[classIds.indexOf(classId)]?.data?.body.data;
  const rows = groupAssignments(me.body.assignments, sectionsOf);
  const waiting = sections.some((s) => s.data === undefined && s.isPending);
  const today = todayInSchool();

  return (
    <Screen
      title="Classes"
      accessory={<SyncChip />}
      banner={
        !online || session.meStale ? (
          <OfflineNotice serverTime={me.serverTime} isDevice={me.serverTimeIsDevice} />
        ) : null
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          enabled={online}
          onRefresh={() => {
            setRefreshing(true);
            void session.refreshMe().finally(() => setRefreshing(false));
          }}
        />
      }
      testID="classes.screen"
    >
      {rows.length === 0 ? (
        waiting ? (
          <LoadingState />
        ) : (
          <EmptyState title="No classes assigned to you today. Ask the office." />
        )
      ) : (
        rows.map((row) => {
          const actions = actionsFor(me.body, row);
          return (
            <Sheet key={row.sectionId} testID={`classes.section.${row.sectionId}`}>
              <View style={styles.head}>
                <Text style={styles.title}>{sectionTitle(row)}</Text>
                <Text style={styles.caption}>
                  {[
                    ...row.roles,
                    row.attendanceMode === 'daily' ? 'Daily register' : 'Period register',
                  ].join(' · ')}
                </Text>
              </View>
              {actions.register.shown ? (
                <ListRow
                  title="Register"
                  detail={actions.register.reason}
                  onPress={
                    actions.register.enabled
                      ? () =>
                          router.push({
                            pathname: '/classes/[sectionId]/register',
                            params: { sectionId: row.sectionId, date: today, period: '1' },
                          })
                      : undefined
                  }
                  testID={`classes.section.${row.sectionId}.register`}
                />
              ) : null}
              {actions.diary ? (
                <ListRow
                  title="Diary"
                  onPress={() =>
                    router.push({
                      pathname: '/classes/[sectionId]/diary',
                      params: { sectionId: row.sectionId },
                    })
                  }
                  testID={`classes.section.${row.sectionId}.diary`}
                />
              ) : null}
              {actions.students ? (
                <ListRow
                  title="Students"
                  onPress={() =>
                    router.push({
                      pathname: '/classes/[sectionId]/students',
                      params: { sectionId: row.sectionId },
                    })
                  }
                  testID={`classes.section.${row.sectionId}.students`}
                />
              ) : null}
            </Sheet>
          );
        })
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { paddingTop: 8, gap: 2 },
  title: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
