import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../auth/session';
import { groupAssignments, sectionTitle, wholeClassIds } from '../classes/my-classes';
import { useClassSections } from '../classes/MyClassesScreen';
import { useOnline } from '../net/connectivity';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { EmptyState, LoadingState, OfflineNotice } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';
import { colors, fontSize } from '../ui/theme';

// Marks — /marks (plan §3.8, contracts/slice-30.md §9): the caller's sections from their
// assignments; each opens the section's tests. Not secure: no child's name.

export function MarksHomeScreen() {
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

  return (
    <Screen
      title="Marks"
      accessory={<SyncChip />}
      banner={
        !online || session.meStale ? (
          <OfflineNotice serverTime={me.serverTime} isDevice={me.serverTimeIsDevice} />
        ) : null
      }
      refreshing={refreshing}
      onRefresh={() => {
        setRefreshing(true);
        void session.refreshMe().finally(() => setRefreshing(false));
      }}
      testID="marks.screen"
    >
      {rows.length === 0 ? (
        <EmptyState title="No classes assigned to you today. Ask the office." />
      ) : (
        <Sheet>
          {rows.map((row) => (
            <ListRow
              key={row.sectionId}
              title={sectionTitle(row.className, row.sectionName)}
              detail={row.roles.join(' · ')}
              onPress={() =>
                router.push({
                  pathname: '/marks/[sectionId]',
                  params: { sectionId: row.sectionId, classId: row.classId },
                })
              }
              testID={`marks.section.${row.sectionId}`}
            />
          ))}
        </Sheet>
      )}
      <View style={styles.note}>
        <Text style={styles.caption}>
          You enter marks for the subjects you teach. A class teacher reads every subject of the
          section.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  note: { paddingTop: 8 },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
