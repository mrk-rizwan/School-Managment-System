import { formatDateTime } from '@asms/shared';
import { useQuery } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrap } from '../api/client';
import { queryKeys } from '../api/query-keys';
import { colors, fontSize, space } from '../ui/theme';
import { STATUS_WORDS } from './register-model';

/**
 * A mark's history (slice-16 §4.2): GET /attendance-marks/:id/changes, opened online only and not
 * kept on the device — "from → to, by <name>, reason".
 */
export function MarkHistory({ markId }: { markId: string }) {
  const changes = useQuery({
    queryKey: queryKeys.markChanges(markId, 1),
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/attendance-marks/{id}/changes', {
          params: { path: { id: markId }, query: { limit: 25 } },
        }),
      ),
  });
  if (changes.isPending) return <Text style={styles.caption}>Loading the history…</Text>;
  if (changes.isError) return <Text style={styles.caption}>The history could not be loaded.</Text>;
  if (changes.data.data.length === 0) return <Text style={styles.caption}>Never amended.</Text>;
  return (
    <View style={styles.list} testID="register.history">
      <Text style={styles.heading}>Mark history</Text>
      {changes.data.data.map((change) => (
        <Text key={change.id} style={styles.line}>
          {`${STATUS_WORDS[change.fromStatus]} → ${STATUS_WORDS[change.toStatus]}, by ${
            change.changedByName ?? 'staff'
          }, ${formatDateTime(change.changedAt)}: ${change.reason}`}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.xs },
  heading: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  line: { fontSize: fontSize.small, color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
