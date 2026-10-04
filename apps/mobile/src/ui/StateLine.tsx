import { DEFAULT_TIMEZONE } from '@asms/shared';
import { StyleSheet, Text } from 'react-native';
import type { OutboxView } from '../db/local.repository';
import { colors, fontSize } from './theme';

// The outbox state of a local row (slice-16 §12): on the device, sending, on the server at a
// time, or not saved with the server's reason. "Saved on server" appears only after the server's
// 2xx (R157, plan §0.15): from a done outbox row or the time its follow-up wrote.

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: DEFAULT_TIMEZONE,
});

export type LocalState =
  | { kind: 'device'; retryInMinutes: number | null }
  | { kind: 'sending' }
  | { kind: 'server'; at: string }
  | { kind: 'failed'; message: string; code: string | null };

export function localState(
  outbox: OutboxView | null,
  savedOnServerAt: string | null,
  now: number = Date.now(),
): LocalState {
  if (outbox === null || outbox.state === 'done') {
    const at = savedOnServerAt ?? (outbox?.state === 'done' ? outbox.updatedAt : null);
    // No outbox row and no server time: never confirmed by the server.
    return at === null ? { kind: 'device', retryInMinutes: null } : { kind: 'server', at };
  }
  if (outbox.state === 'sending') return { kind: 'sending' };
  if (outbox.state === 'failed') {
    return {
      kind: 'failed',
      message: outbox.responseMessage ?? 'refused',
      code: outbox.responseCode,
    };
  }
  const due = outbox.nextAttemptAt === null ? 0 : Date.parse(outbox.nextAttemptAt) - now;
  return { kind: 'device', retryInMinutes: due > 0 ? Math.ceil(due / 60_000) : null };
}

export function describeLocalState(state: LocalState): string {
  switch (state.kind) {
    case 'device':
      return state.retryInMinutes === null
        ? 'Saved on device'
        : `Saved on device · retrying in ${state.retryInMinutes} min`;
    case 'sending':
      return 'Sending';
    case 'server':
      return `Saved on server at ${timeFormat.format(new Date(state.at))}`;
    case 'failed':
      return `Not saved: ${state.message}`;
  }
}

export function StateLine({ state, testID }: { state: LocalState; testID?: string }) {
  return (
    <Text
      style={[styles.line, state.kind === 'failed' && styles.failed]}
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      {describeLocalState(state)}
    </Text>
  );
}

const styles = StyleSheet.create({
  line: { fontSize: fontSize.small, color: colors.mutedForeground },
  failed: { color: colors.destructive },
});
