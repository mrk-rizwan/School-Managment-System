import { formatDay, REMARK_CATEGORIES, todayInSchool, type RemarkCategory } from '@asms/shared';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import type { CreateRemarkDto } from '../api/contracts';
import { saveRemark, type LocalRemark } from '../db/local.repository';
import { sensitiveTextError } from '../outbox/bodies';
import { outboxWorker } from '../outbox/runtime';
import { log } from '../platform/log';
import { Button } from '../ui/Button';
import { DateSheet } from '../ui/DateSheet';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { colors, fontSize } from '../ui/theme';

// A new remark (slice-16 §4.6), saved on the device with its outbox row; the outbox id is the
// Idempotency-Key. Visibility defaults to "School default": the field is left out and the server
// applies the school's setting, which the app cannot read (decision 10).

export const CATEGORY_LABELS: Record<RemarkCategory, string> = {
  academic: 'Academic',
  behaviour: 'Behaviour',
  homework: 'Homework',
  attendance: 'Attendance',
  participation: 'Participation',
  general: 'General',
};

type Visibility = NonNullable<CreateRemarkDto['visibility']>;
const VISIBILITY_OPTIONS: { value: Visibility | 'default'; label: string }[] = [
  { value: 'default', label: 'School default' },
  { value: 'internal', label: 'Staff only' },
  { value: 'guardian', label: 'Parents' },
  { value: 'student', label: 'Parents and student' },
];

type Props = {
  visible: boolean;
  studentId: string;
  /** The subjects the caller may tag; empty: no subject choice. */
  subjects: readonly { id: string; name: string }[];
  /** "Edit and resend": the failed remark to pre-fill from and replace. */
  resend: LocalRemark | null;
  onClose: () => void;
  onSaved: () => void;
};

/** Mounted only while open, so every opening starts empty (or from the remark being resent). */
export function RemarkForm({ visible, ...rest }: Props) {
  return visible ? <OpenRemarkForm {...rest} /> : null;
}

function OpenRemarkForm({ studentId, subjects, resend, onClose, onSaved }: Omit<Props, 'visible'>) {
  const today = todayInSchool();
  const [date, setDate] = useState(resend?.date ?? today);
  const [category, setCategory] = useState<RemarkCategory>(
    (resend?.category as RemarkCategory | undefined) ?? 'general',
  );
  const [text, setText] = useState(resend?.text ?? '');
  const [visibility, setVisibility] = useState<Visibility | 'default'>(
    (resend?.visibility as Visibility | null) ?? 'default',
  );
  const [subjectId, setSubjectId] = useState<string>(resend?.subjectId ?? 'none');
  const [dateOpen, setDateOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    const trimmed = text.trim();
    const problem =
      trimmed.length < 1
        ? 'Write the remark.'
        : trimmed.length > 1000
          ? 'At most 1000 characters.'
          : sensitiveTextError(text);
    setError(problem);
    if (problem !== null) return;
    setBusy(true);
    try {
      await saveRemark(
        studentId,
        {
          date,
          category,
          text,
          visibility: visibility === 'default' ? null : visibility,
          subjectId: subjectId === 'none' ? null : subjectId,
        },
        new Date(),
        resend?.id ?? null,
      );
      log('info', 'remark.saved_on_device', { studentId });
      void outboxWorker.trigger('enqueued');
      onSaved();
      onClose();
    } catch {
      setError('Could not save on this phone. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSheet
      visible
      title={resend ? 'Edit and resend' : 'New remark'}
      onClose={onClose}
      testID="remarkForm"
      footer={
        <Button
          label="Save remark"
          busy={busy}
          onPress={() => void save()}
          testID="remarkForm.save"
        />
      }
    >
      <ListRow
        title="Date"
        value={date === today ? `Today, ${formatDay(date)}` : formatDay(date)}
        onPress={() => setDateOpen(true)}
        testID="remarkForm.date"
      />
      <SegmentedPicker
        label="Category"
        options={REMARK_CATEGORIES.map((c) => ({ value: c, label: CATEGORY_LABELS[c] }))}
        value={category}
        onChange={setCategory}
        testID="remarkForm.category"
      />
      <Field
        label="Remark"
        value={text}
        onChangeText={setText}
        multiline
        maxLength={1000}
        error={error}
        testID="remarkForm.text"
      />
      <SegmentedPicker
        label="Who can see it"
        options={VISIBILITY_OPTIONS}
        value={visibility}
        onChange={setVisibility}
        testID="remarkForm.visibility"
      />
      {subjects.length > 0 ? (
        <SegmentedPicker
          label="Subject (optional)"
          options={[
            { value: 'none', label: 'None' },
            ...subjects.map((s) => ({ value: s.id, label: s.name })),
          ]}
          value={subjectId}
          onChange={setSubjectId}
          testID="remarkForm.subject"
        />
      ) : null}
      <Text style={styles.caption}>
        Saved on this phone first; sent when there is a connection.
      </Text>
      <DateSheet
        visible={dateOpen}
        today={today}
        value={date}
        onClose={() => setDateOpen(false)}
        onPick={(picked) => {
          setDate(picked);
          setDateOpen(false);
        }}
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
});
