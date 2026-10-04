import {
  ApiError,
  DEFAULT_TIMEZONE,
  describeApiError,
  formatDateTime,
  todayInSchool,
} from '@asms/shared';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { colors, fontSize, space } from './theme';

// The four states every screen has, plus the offline notice — mirroring the web's
// components/page-states.tsx (slice-15 §11). Words match the web where the state is the same.

export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <View
      style={styles.frame}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      testID="state.loading"
    >
      <ActivityIndicator color={colors.primary} />
    </View>
  );
}

export function EmptyState({
  title = 'Nothing here yet',
  description,
}: {
  title?: string;
  description?: string;
}) {
  return (
    <View style={styles.frame} testID="state.empty">
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.text}>{description}</Text> : null}
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof ApiError
      ? describeApiError(error)
      : 'Cannot reach the school. Check your connection and try again.';
  return (
    <View style={styles.frame} testID="state.error">
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.text}>{message}</Text>
      {onRetry ? (
        <Button label="Try again" variant="secondary" onPress={onRetry} testID="state.retry" />
      ) : null}
    </View>
  );
}

export function NoPermissionState({
  description = 'Your account does not have access to this. Ask your principal if you need it.',
}: {
  description?: string;
}) {
  return (
    <View style={styles.frame} testID="state.noPermission">
      <Text style={styles.title}>You do not have access</Text>
      <Text style={styles.text}>{description}</Text>
    </View>
  );
}

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: DEFAULT_TIMEZONE,
});
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: DEFAULT_TIMEZONE });

/** "as of 09:32" in school time today, else with the date; "(device time)" when no Date header. */
export function formatAsOf(serverTime: string, isDevice = false): string {
  const instant = new Date(serverTime);
  const sameDay = dayFormat.format(instant) === todayInSchool();
  const when = sameDay ? timeFormat.format(instant) : formatDateTime(serverTime);
  return `as of ${when}${isDevice ? ' (device time)' : ''}`;
}

/** Cached data on screen: offline, or the last refresh failed. */
export function OfflineNotice({
  serverTime,
  isDevice = false,
}: {
  serverTime: string | null;
  isDevice?: boolean;
}) {
  return (
    <View style={styles.notice} accessibilityRole="alert" testID="state.offline">
      <Text style={styles.noticeText}>
        {serverTime === null
          ? 'Offline.'
          : `Offline — showing what was saved, ${formatAsOf(serverTime, isDevice)}.`}
      </Text>
    </View>
  );
}

/** The quiet "as of" line under a heading. */
export function AsOf({ serverTime, isDevice = false }: { serverTime: string; isDevice?: boolean }) {
  return (
    <Text style={styles.asOf} testID="state.asOf">
      {formatAsOf(serverTime, isDevice)}
    </Text>
  );
}

const styles = StyleSheet.create({
  frame: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.xl,
  },
  title: {
    fontSize: fontSize.title,
    fontWeight: '600',
    color: colors.foreground,
    textAlign: 'center',
  },
  text: { fontSize: fontSize.small, color: colors.mutedForeground, textAlign: 'center' },
  notice: {
    marginHorizontal: space.lg,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    backgroundColor: colors.muted,
    borderRadius: 6,
  },
  noticeText: { fontSize: fontSize.small, color: colors.foreground },
  asOf: { fontSize: fontSize.caption, color: colors.mutedForeground },
});
