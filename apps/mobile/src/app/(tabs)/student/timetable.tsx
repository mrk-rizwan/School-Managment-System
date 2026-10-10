import { FamilyTimetableScreen } from '../../../timetable/TimetableScreens';

// /student/timetable (slice 37): the student's own section week. Not secure: no name shown.
export default function OwnTimetableRoute() {
  return <FamilyTimetableScreen source={{ kind: 'own' }} />;
}
