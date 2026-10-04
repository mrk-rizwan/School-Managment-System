import { todayInSchool } from '@asms/shared';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { api, unwrap, unwrapWithDate } from '../api/client';
import type { SectionDayDto, StaffDto, TeacherAssignmentDto } from '../api/contracts';
import { queryKeys } from '../api/query-keys';
import { useCachedQuery } from '../db/use-cached-query';
import { useOnlineOnly } from '../net/connectivity';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ListRow } from '../ui/ListRow';
import { ModalSheet } from '../ui/ModalSheet';
import { LoadingState } from '../ui/states';
import { colors, fontSize } from '../ui/theme';
import {
  coveredAssignment,
  coverOutcome,
  isIsoDate,
  looksLikeIdentity,
  sectionLabel,
} from './today-model';

// Assign cover — online only (slice-16 §7.1, R162; `assign_cover` is never a lane). The staff
// list shows names and designations only — never a phone or an identity number (§13.5).

/** A staff row as the picker keeps it. */
export type StaffChoice = Pick<StaffDto, 'id' | 'fullName' | 'designation'>;

export const staffChoice = ({ id, fullName, designation }: StaffDto): StaffChoice => ({
  id,
  fullName,
  designation,
});

type Props = {
  row: SectionDayDto | null;
  onClose: () => void;
  /** The cover is arranged (or already was): the sheet closes and the list refetches. */
  onDone: (message: string) => void;
};

/** Mounted only while open, so every opening starts clean. */
export function CoverSheet({ row, ...rest }: Props) {
  return row === null ? null : <OpenCoverSheet key={row.sectionId} row={row} {...rest} />;
}

function OpenCoverSheet({ row, onClose, onDone }: Omit<Props, 'row'> & { row: SectionDayDto }) {
  const gate = useOnlineOnly('assign_cover');
  const today = todayInSchool();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState<StaffChoice | null>(null);
  const [startsOn, setStartsOn] = useState(today);
  const [endsOn, setEndsOn] = useState(today);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const staff = useCachedQuery<{ data: StaffChoice[] }>(
    queryKeys.activeStaff(1),
    '/api/v1/staff',
    { status: 'active', limit: 50, page: 1 },
    async () => {
      const { data, date } = await unwrapWithDate(
        api.GET('/api/v1/staff', { params: { query: { status: 'active', limit: 50, page: 1 } } }),
      );
      // Only what the picker shows reaches memory and the disk cache: never the phone, the
      // masked identity number or the user id (review M3).
      return { data: { data: data.data.map(staffChoice) }, date };
    },
  );
  const classTeacher = row.classTeacherStaffId;
  const assignments = useCachedQuery<{ data: TeacherAssignmentDto[] }>(
    queryKeys.staffAssignments(classTeacher ?? 'none'),
    `/api/v1/staff/${classTeacher ?? 'none'}/teacher-assignments`,
    { limit: 50 },
    () =>
      unwrapWithDate(
        api.GET('/api/v1/staff/{id}/teacher-assignments', {
          params: { path: { id: classTeacher! }, query: { limit: 50 } },
        }),
      ),
    { enabled: classTeacher !== null },
  );

  const identityTyped = looksLikeIdentity(search);
  const needle = search.trim().toLowerCase();
  const people = (staff.data?.body.data ?? []).filter(
    (s) => identityTyped || needle === '' || s.fullName.toLowerCase().includes(needle),
  );
  const covered =
    classTeacher === null ? null : coveredAssignment(assignments.data?.body.data ?? [], row.sectionId);
  const waitingForCovered = classTeacher !== null && assignments.data === undefined;
  // Without the class teacher's row the cover cannot name what it covers: no submit (review L4).
  const coveredFailed = waitingForCovered && assignments.isError;

  async function submit() {
    const problems: Record<string, string> = {};
    if (chosen === null) problems.staff = 'Choose who covers.';
    if (!isIsoDate(startsOn)) problems.startsOn = 'Use YYYY-MM-DD.';
    if (!isIsoDate(endsOn)) problems.endsOn = 'Use YYYY-MM-DD.';
    else if (isIsoDate(startsOn) && endsOn < startsOn) problems.endsOn = 'Ends before it starts.';
    setErrors(problems);
    if (Object.keys(problems).length > 0 || chosen === null) return;
    setBusy(true);
    setMessage(null);
    try {
      await unwrap(
        api.POST('/api/v1/staff/{id}/teacher-assignments', {
          params: { path: { id: chosen.id } },
          body: {
            role: 'cover',
            classId: row.classId,
            sectionId: row.sectionId,
            startsOn,
            endsOn,
            ...(covered === null ? {} : { coversAssignmentId: covered.id }),
          },
        }),
      );
      onDone(`Cover arranged; ${chosen.fullName} has been told.`);
    } catch (error) {
      const outcome = coverOutcome(error, chosen.fullName);
      if (outcome.done) onDone(outcome.message);
      else setMessage(outcome.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalSheet
      visible
      title={`Cover for ${sectionLabel(row)}`}
      onClose={onClose}
      testID="cover"
      footer={
        <>
          {message ? (
            <Text style={styles.error} testID="cover.message">
              {message}
            </Text>
          ) : null}
          {gate.reason ? <Text style={styles.note}>{gate.reason}</Text> : null}
          <Button
            label="Arrange cover"
            onPress={() => void submit()}
            disabled={!gate.enabled || waitingForCovered}
            busy={busy}
            testID="cover.submit"
          />
        </>
      }
    >
      <Text style={styles.note}>
        {classTeacher === null
          ? 'Covering a section with no class teacher.'
          : `Covering for ${row.classTeacherName ?? 'the class teacher'}.`}
      </Text>
      <Field
        label="Search staff"
        value={search}
        onChangeText={setSearch}
        hint={identityTyped ? 'Search by name' : null}
        testID="cover.search"
      />
      {coveredFailed ? (
        <>
          <Text style={styles.error} testID="cover.assignmentsFailed">
            {"Cannot load the class teacher's assignment. Check the connection."}
          </Text>
          <Button
            label="Retry"
            variant="secondary"
            onPress={() => void assignments.refetch()}
            testID="cover.retry"
          />
        </>
      ) : null}
      {errors.staff ? <Text style={styles.error}>{errors.staff}</Text> : null}
      {staff.data === undefined ? (
        staff.isError ? (
          <Text style={styles.note}>Cannot load the staff list. Check the connection.</Text>
        ) : (
          <LoadingState />
        )
      ) : people.length === 0 ? (
        <Text style={styles.note}>No one matches.</Text>
      ) : (
        people.map((person) => (
          <ListRow
            key={person.id}
            title={person.fullName}
            detail={person.designation}
            value={chosen?.id === person.id ? 'Chosen' : null}
            onPress={() => setChosen(person)}
            testID={`cover.staff.${person.id}`}
          />
        ))
      )}
      <Field
        label="From (YYYY-MM-DD)"
        value={startsOn}
        maxLength={10}
        onChangeText={setStartsOn}
        error={errors.startsOn}
        testID="cover.startsOn"
      />
      <Field
        label="Until (YYYY-MM-DD)"
        value={endsOn}
        maxLength={10}
        onChangeText={setEndsOn}
        error={errors.endsOn}
        testID="cover.endsOn"
      />
    </ModalSheet>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: fontSize.small, color: colors.mutedForeground },
  error: { fontSize: fontSize.small, color: colors.destructive },
});
