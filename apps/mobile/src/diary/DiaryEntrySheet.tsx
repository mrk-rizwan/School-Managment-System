import { formatDay } from '@asms/shared';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useOnline } from '../net/connectivity';
import { Attachment, attachmentWord } from '../ui/Attachment';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { Sheet } from '../ui/Sheet';
import { NoDataState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';

// One diary entry, all its fields (slice-16 §4.4, §5.3): the staff list, a child's diary and a
// student's own diary share it. The attachment loads only on a tap (R160).

type EntryView = {
  id: string;
  date: string;
  heading: string;
  topic: string;
  assignment: string | null;
  learningOutcome: string | null;
  dueOn: string | null;
  authorName: string | null;
  edited: boolean;
  attachmentMime: string | null;
  attachmentSizeBytes: number | null;
};

export const dueLine = (dueOn: string | null) => (dueOn ? `Due ${formatDay(dueOn)}` : null);

/** The fields every diary entry DTO shares (DiaryEntryDto, MyDiaryEntryDto). */
type DiaryEntryLike = {
  id: string;
  date: string;
  subjectName: string;
  topic: string;
  assignment: string | null;
  learningOutcome: string | null;
  dueOn: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
  attachmentMime: string | null;
  attachmentSizeBytes: number | null;
};

const isEdited = (entry: Pick<DiaryEntryLike, 'createdAt' | 'updatedAt'>) =>
  Date.parse(entry.updatedAt) > Date.parse(entry.createdAt);

/** The sheet's view of a server entry, under the heading its screen gives it. */
export function entryView(entry: DiaryEntryLike, heading: string): EntryView {
  return {
    id: entry.id,
    date: entry.date,
    heading,
    topic: entry.topic,
    assignment: entry.assignment,
    learningOutcome: entry.learningOutcome,
    dueOn: entry.dueOn,
    authorName: entry.authorName,
    edited: isEdited(entry),
    attachmentMime: entry.attachmentMime,
    attachmentSizeBytes: entry.attachmentSizeBytes,
  };
}

/**
 * One window of a diary (a week for staff, a fortnight for a family): its cached page, its
 * no-data states, and a row per entry. The caller owns the read; this renders it.
 */
export function DiaryWindow<E extends DiaryEntryLike>({
  query,
  range,
  hide,
  rowTitle,
  showEdited = false,
  onOpen,
  testID,
  entryTestID,
  offlineMessage,
}: {
  query: {
    data?: { body: { data: E[] } };
    isError: boolean;
    error: unknown;
    refetch: () => unknown;
  };
  range: { dateFrom: string; dateTo: string };
  /** Server ids already shown elsewhere (this phone's own rows). */
  hide?: ReadonlySet<string>;
  rowTitle: (entry: E) => string;
  showEdited?: boolean;
  onOpen: (entry: E) => void;
  testID: string;
  entryTestID: (entry: E) => string;
  offlineMessage: string;
}) {
  if (query.data === undefined) {
    return (
      <NoDataState
        isError={query.isError}
        error={query.error}
        onRetry={() => void query.refetch()}
        offlineMessage={offlineMessage}
      />
    );
  }
  const entries = query.data.body.data.filter((entry) => !hide?.has(entry.id));
  return (
    <Sheet title={`${formatDay(range.dateFrom)} – ${formatDay(range.dateTo)}`} testID={testID}>
      {entries.length === 0 ? (
        <Text style={styles.caption}>No entries.</Text>
      ) : (
        entries.map((entry) => (
          <ListRow
            key={entry.id}
            title={rowTitle(entry)}
            detail={[
              entry.topic,
              dueLine(entry.dueOn),
              showEdited && isEdited(entry) ? 'edited' : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            value={attachmentWord(entry.attachmentMime)}
            onPress={() => onOpen(entry)}
            testID={entryTestID(entry)}
          />
        ))
      )}
    </Sheet>
  );
}

export function DiaryEntrySheet({
  entry,
  attachmentBase,
  onClose,
  children,
}: {
  entry: EntryView | null;
  /** The entry's path for /thumbnail and /attachment; null when it has none on the server yet. */
  attachmentBase: string | null;
  onClose: () => void;
  /** Extra content: a local entry's state line and remedies. */
  children?: ReactNode;
}) {
  const online = useOnline();
  if (entry === null) return null;
  return (
    <ModalSheet visible title={entry.heading} onClose={onClose} testID="diary.entrySheet">
      <Text style={styles.caption}>
        {[formatDay(entry.date), entry.edited ? 'edited' : null].filter(Boolean).join(' · ')}
      </Text>
      <Field label="Topic" text={entry.topic} />
      <Field label="Assignment" text={entry.assignment} />
      <Field label="Learning outcome" text={entry.learningOutcome} />
      <Field label="Due" text={entry.dueOn ? formatDay(entry.dueOn) : null} />
      <Field label="Written by" text={entry.authorName} />
      {entry.attachmentMime !== null && attachmentBase !== null ? (
        <Attachment
          basePath={attachmentBase}
          mime={entry.attachmentMime}
          sizeBytes={entry.attachmentSizeBytes}
          online={online}
        />
      ) : null}
      {children}
    </ModalSheet>
  );
}

function Field({ label, text }: { label: string; text: string | null }) {
  if (text === null || text === '') return null;
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.text} selectable>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  field: { gap: space.xs },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.mutedForeground },
  text: { fontSize: fontSize.body, color: colors.foreground },
});
