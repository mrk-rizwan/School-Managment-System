import {
  formatDay,
  MAX_ASSESSMENT_MARKS,
  TEST_TYPE_LABELS,
  TEST_TYPES,
  todayInSchool,
  type TestType,
} from '@asms/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrapWithDate } from '../api/client';
import type { ClassSubjectDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useSession } from '../auth/session';
import { getLocalAssessment, saveLocalAssessment } from '../db/local-marks.repository';
import { useCachedQuery } from '../db/use-cached-query';
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
import { colors, fontSize } from '../ui/theme';
import { markSubjects } from './SectionAssessmentsScreen';

// A new class test — /marks/[sectionId]/new (plan §3.8): saved on the device with its outbox row
// (assessment_create; the outbox id is the Idempotency-Key), offline too. Its marks can be typed
// at once and wait for the test's server id. Not secure: no child's name.

type Page = { data: ClassSubjectDto[] };

export function NewTestScreen({
  sectionId,
  classId,
  resend = null,
}: {
  sectionId: string;
  classId: string | null;
  /** "Edit and resend": the failed local test to pre-fill from and replace. */
  resend?: string | null;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const { me } = useSession();
  const today = todayInSchool();
  const [classSubjectId, setClassSubjectId] = useState<string | null>(null);
  const [testType, setTestType] = useState<TestType>('weekly');
  const [name, setName] = useState('');
  const [maxMarks, setMaxMarks] = useState('20');
  const [heldOn, setHeldOn] = useState(today);
  const [dateOpen, setDateOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const subjectsQuery = useCachedQuery<Page>(
    queryKeys.classSubjects(classId ?? ''),
    `/api/v1/classes/${classId ?? ''}/subjects`,
    { limit: 50 },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/classes/{id}/subjects', {
          params: { path: { id: classId ?? '' }, query: { limit: 50 } },
        }),
      ),
    { enabled: classId !== null },
  );

  useEffect(() => {
    if (resend === null) return;
    void getLocalAssessment(resend).then((test) => {
      if (test === null) return;
      setClassSubjectId(test.classSubjectId);
      setTestType(test.testType);
      setName(test.name);
      setMaxMarks(String(test.maxMarks));
      setHeldOn(test.heldOn);
    });
  }, [resend]);

  if (me === null) return <LoadingState />;
  const mine = markSubjects(me.body, sectionId, classId);
  const choices = (subjectsQuery.data?.body.data ?? []).filter(
    (cs) => mine === 'all' || mine.includes(cs.subjectId),
  );

  async function save() {
    const problems: Record<string, string> = {};
    const chosen = choices.find((cs) => cs.id === classSubjectId);
    if (chosen === undefined) problems.subject = 'Choose a subject.';
    const trimmed = name.trim();
    if (trimmed.length < 1) problems.name = 'Name the test.';
    else if (trimmed.length > 80) problems.name = 'At most 80 characters.';
    const sensitive = sensitiveTextError(name);
    if (sensitive) problems.name = sensitive;
    const max = Number(maxMarks.trim());
    if (!/^[0-9]{1,4}$/.test(maxMarks.trim()) || max < 1 || max > MAX_ASSESSMENT_MARKS) {
      problems.maxMarks = `A whole number from 1 to ${MAX_ASSESSMENT_MARKS}.`;
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0 || chosen === undefined) return;
    setBusy(true);
    try {
      await saveLocalAssessment(
        {
          classSubjectId: chosen.id,
          subjectId: chosen.subjectId,
          sectionId,
          testType,
          name: trimmed,
          maxMarks: max,
          heldOn,
        },
        new Date(),
        resend,
      );
      log('info', 'assessment.saved_on_device', { sectionId });
      void client.invalidateQueries({ queryKey: queryKeys.local });
      void outboxWorker.trigger('enqueued');
      router.back();
    } catch (error) {
      log('warn', 'assessment.save_failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      setMessage('Could not save on this phone. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen
      title={resend ? 'Edit and resend' : 'New test'}
      testID="newTest.screen"
      footer={
        <Button label="Save test" busy={busy} onPress={() => void save()} testID="newTest.save" />
      }
    >
      {choices.length === 0 && subjectsQuery.isPending ? (
        <LoadingState label="Loading subjects" />
      ) : choices.length === 0 ? (
        <Text style={styles.error}>
          No subject of yours is on this class’s list. Ask the principal.
        </Text>
      ) : (
        <SegmentedPicker
          label="Subject"
          options={choices.map((cs) => ({ value: cs.id, label: cs.subjectName }))}
          value={classSubjectId}
          onChange={setClassSubjectId}
          testID="newTest.subject"
        />
      )}
      {errors.subject ? <Text style={styles.error}>{errors.subject}</Text> : null}
      <SegmentedPicker
        label="Type"
        options={TEST_TYPES.map((value) => ({ value, label: TEST_TYPE_LABELS[value] }))}
        value={testType}
        onChange={setTestType}
        testID="newTest.type"
      />
      <Field
        label="Name"
        value={name}
        onChangeText={setName}
        maxLength={80}
        error={errors.name}
        testID="newTest.name"
      />
      <Field
        label="Maximum marks"
        value={maxMarks}
        onChangeText={setMaxMarks}
        keyboardType="number-pad"
        maxLength={4}
        error={errors.maxMarks}
        testID="newTest.maxMarks"
      />
      <ListRow
        title="Held on"
        value={heldOn === today ? `Today, ${formatDay(heldOn)}` : formatDay(heldOn)}
        onPress={() => setDateOpen(true)}
        testID="newTest.heldOn"
      />
      {message ? (
        <Text style={styles.error} testID="newTest.message">
          {message}
        </Text>
      ) : null}
      <DateSheet
        visible={dateOpen}
        today={today}
        value={heldOn}
        onClose={() => setDateOpen(false)}
        onPick={(picked) => {
          setHeldOn(picked);
          setDateOpen(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  error: { fontSize: fontSize.small, color: colors.destructive },
});
