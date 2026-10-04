import { Capability, formatDay, todayInSchool } from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { MeDto, SubjectDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { schoolWide } from '../auth/capabilities';
import { useSession } from '../auth/session';
import { listLocalDiaryEntries, saveDiaryEntry, type LocalPhoto } from '../db/local.repository';
import { useCachedQuery } from '../db/use-cached-query';
import { deleteOutboxFile } from '../media/files';
import { pickPhoto } from '../media/picker';
import { useOnline } from '../net/connectivity';
import { sensitiveTextError } from '../outbox/bodies';
import { outboxWorker } from '../outbox/runtime';
import { log } from '../platform/log';
import { Button } from '../ui/Button';
import { DateSheet } from '../ui/DateSheet';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { SegmentedPicker } from '../ui/SegmentedPicker';
import { LoadingState } from '../ui/states';
import { colors, fontSize, space } from '../ui/theme';
import { addDays } from './dates';

// A new diary entry — /classes/[sectionId]/diary/new (slice-16 §4.4). Saved on the device in one
// transaction with its outbox row (the outbox id is the Idempotency-Key); a chosen photo waits
// in its own row and is sent after the entry reaches the server (§4.5). Not secure: no child's
// name. "Photograph the board or the book, not the children."

type Subject = { id: string; name: string };

/**
 * Where the subject list comes from (slice-16 §4.4): the school's list when the key is held
 * school-wide (`MeDto.capabilityScopes`, slice-14 §8 — the principal, a grant) or the caller is
 * the section's class teacher or cover; else a subject teacher's own subjects on the section.
 * Without either, nothing: scope comes from assignments, never from the key alone (rule 13).
 */
export function ownSubjects(
  me: Pick<MeDto, 'assignments' | 'capabilities' | 'capabilityScopes'>,
  capability: Capability,
  sectionId: string,
  classId: string | null,
): Subject[] | 'all' {
  if (schoolWide(me, capability)) return 'all';
  const onSection = me.assignments.filter(
    (a) => a.sectionId === sectionId || (a.sectionId === null && a.classId === classId),
  );
  if (onSection.some((a) => a.role === 'class_teacher' || a.role === 'cover')) return 'all';
  const subjects = new Map<string, string>();
  for (const a of onSection) {
    if (a.subjectId !== null && a.subjectName !== null) subjects.set(a.subjectId, a.subjectName);
  }
  return [...subjects].map(([id, name]) => ({ id, name }));
}

function useSchoolSubjects(enabled: boolean) {
  return useCachedQuery<{ data: SubjectDto[] }>(
    queryKeys.subjects,
    '/api/v1/subjects',
    { limit: 50 },
    () => unwrapWithDate(api.GET('/api/v1/subjects', { params: { query: { limit: 50 } } })),
    { enabled },
  );
}

export function DiaryComposeScreen({
  sectionId,
  classId = null,
  resend = null,
}: {
  sectionId: string;
  classId?: string | null;
  /** "Edit and resend": the failed local entry to pre-fill from and replace. */
  resend?: string | null;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const online = useOnline();
  const { me } = useSession();
  const today = todayInSchool();
  const [date, setDate] = useState(today);
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [topic, setTopic] = useState('');
  const [assignment, setAssignment] = useState('');
  const [learningOutcome, setLearningOutcome] = useState('');
  const [dueOn, setDueOn] = useState<string | null>(null);
  const [photo, setPhoto] = useState<LocalPhoto | null>(null);
  const [keepsPhoto, setKeepsPhoto] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const own = me ? ownSubjects(me.body, Capability.DIARY_WRITE, sectionId, classId) : [];
  const school = useSchoolSubjects(own === 'all');
  const subjects: Subject[] =
    own === 'all'
      ? (school.data?.body.data ?? [])
          .filter((s) => s.archivedAt === null)
          .map((s) => ({ id: s.id, name: s.name }))
      : own;

  useEffect(() => {
    if (resend === null) return;
    void listLocalDiaryEntries(sectionId).then((entries) => {
      const entry = entries.find((e) => e.id === resend);
      if (entry === undefined) return;
      setDate(entry.date);
      setSubjectId(entry.subjectId);
      setTopic(entry.topic);
      setAssignment(entry.assignment ?? '');
      setLearningOutcome(entry.learningOutcome ?? '');
      setDueOn(entry.dueOn);
      setKeepsPhoto(entry.photo?.state === 'waiting');
    });
  }, [resend, sectionId]);

  async function choosePhoto(source: 'camera' | 'library') {
    setMessage(null);
    const result = await pickPhoto(source);
    if (result.kind === 'refused') setMessage(result.message);
    if (result.kind === 'picked') {
      if (photo !== null) deleteOutboxFile(photo.fileName);
      setPhoto(result.photo);
    }
  }

  async function save() {
    const problems: Record<string, string> = {};
    if (subjectId === null) problems.subject = 'Choose a subject.';
    const trimmed = topic.trim();
    if (trimmed.length < 1) problems.topic = 'Write the topic.';
    else if (trimmed.length > 500) problems.topic = 'At most 500 characters.';
    if (assignment.length > 1000) problems.assignment = 'At most 1000 characters.';
    if (learningOutcome.length > 500) problems.learningOutcome = 'At most 500 characters.';
    for (const [field, text] of [
      ['topic', topic],
      ['assignment', assignment],
      ['learningOutcome', learningOutcome],
    ] as const) {
      const problem = sensitiveTextError(text);
      if (problem) problems[field] = problem;
    }
    if (dueOn !== null && dueOn < date) problems.dueOn = 'The due date is on or after the date.';
    setErrors(problems);
    if (Object.keys(problems).length > 0 || subjectId === null) return;
    setBusy(true);
    try {
      await saveDiaryEntry(
        sectionId,
        { date, subjectId, topic, assignment, learningOutcome, dueOn },
        photo,
        new Date(),
        resend,
      );
      log('info', 'diary.saved_on_device', { sectionId, photo: photo !== null });
      // The list below this screen shows the entry at once, offline too.
      void client.invalidateQueries({ queryKey: queryKeys.local });
      if (online) void outboxWorker.trigger('enqueued');
      router.back();
    } catch (error) {
      log('warn', 'diary.save_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      setMessage('Could not save on this phone. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (me === null) return <LoadingState />;
  const dueChoices = [null, ...Array.from({ length: 14 }, (_, i) => addDays(date, i + 1))];

  return (
    <Screen
      title={resend ? 'Edit and resend' : 'New diary entry'}
      testID="diaryCompose.screen"
      footer={
        <Button
          label="Save entry"
          busy={busy}
          onPress={() => void save()}
          testID="diaryCompose.save"
        />
      }
    >
      <ListRow
        title="Date"
        value={date === today ? `Today, ${formatDay(date)}` : formatDay(date)}
        onPress={() => setDateOpen(true)}
        testID="diaryCompose.date"
      />
      {subjects.length === 0 && own === 'all' && school.isPending ? (
        <LoadingState label="Loading subjects" />
      ) : (
        <SegmentedPicker
          label="Subject"
          options={subjects.map((s) => ({ value: s.id, label: s.name }))}
          value={subjectId}
          onChange={setSubjectId}
          testID="diaryCompose.subject"
        />
      )}
      {errors.subject ? <Text style={styles.error}>{errors.subject}</Text> : null}
      <Field
        label="Topic"
        value={topic}
        onChangeText={setTopic}
        maxLength={500}
        error={errors.topic}
        testID="diaryCompose.topic"
      />
      <Field
        label="Assignment (optional)"
        value={assignment}
        onChangeText={setAssignment}
        multiline
        maxLength={1000}
        error={errors.assignment}
        testID="diaryCompose.assignment"
      />
      <Field
        label="Learning outcome (optional)"
        value={learningOutcome}
        onChangeText={setLearningOutcome}
        maxLength={500}
        error={errors.learningOutcome}
        testID="diaryCompose.learningOutcome"
      />
      <SegmentedPicker
        label="Due on (optional)"
        options={dueChoices.map((d) => ({ value: d ?? 'none', label: d ? formatDay(d) : 'None' }))}
        value={dueOn ?? 'none'}
        onChange={(value) => setDueOn(value === 'none' ? null : value)}
        testID="diaryCompose.dueOn"
      />
      {errors.dueOn ? <Text style={styles.error}>{errors.dueOn}</Text> : null}
      <View style={styles.photo}>
        <Text style={styles.label}>Photo (optional)</Text>
        <Text style={styles.caption}>Photograph the board or the book, not the children.</Text>
        {photo !== null ? (
          <Text style={styles.caption} testID="diaryCompose.photoChosen">
            {`Photo chosen (${Math.round(photo.sizeBytes / 1024)} KB) — sent after the entry`}
          </Text>
        ) : keepsPhoto ? (
          <Text style={styles.caption}>The photo from before is kept.</Text>
        ) : null}
        <View style={styles.photoButtons}>
          <Button
            label="Take photo"
            variant="secondary"
            onPress={() => void choosePhoto('camera')}
            testID="diaryCompose.camera"
          />
          <Button
            label="Choose photo"
            variant="secondary"
            onPress={() => void choosePhoto('library')}
            testID="diaryCompose.library"
          />
        </View>
      </View>
      {message ? (
        <Text style={styles.error} testID="diaryCompose.message">
          {message}
        </Text>
      ) : null}
      <DateSheet
        visible={dateOpen}
        today={today}
        value={date}
        onClose={() => setDateOpen(false)}
        onPick={(picked) => {
          setDate(picked);
          if (dueOn !== null && dueOn < picked) setDueOn(null);
          setDateOpen(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { fontSize: fontSize.small, color: colors.destructive },
  label: { fontSize: fontSize.small, fontWeight: '600', color: colors.foreground },
  caption: { fontSize: fontSize.small, color: colors.mutedForeground },
  photo: { gap: space.sm },
  photoButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
});
