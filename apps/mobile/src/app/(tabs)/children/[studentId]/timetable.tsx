import { useLocalSearchParams } from 'expo-router';
import { FamilyTimetableScreen } from '../../../../timetable/TimetableScreens';

// /children/[studentId]/timetable (slice 37): the child's section week. Not secure: the DTO
// carries no child's name and the screen shows none (phase-5-extended.md §3.7).
export default function ChildTimetableRoute() {
  const { studentId } = useLocalSearchParams<{ studentId: string }>();
  return <FamilyTimetableScreen source={{ kind: 'child', studentId }} />;
}
