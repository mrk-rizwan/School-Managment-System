import { AttendanceMonthScreen } from '../../../family/FamilyScreens';

// /student/attendance (slice-16 §5.5): the student's own. Their name heads it: secure.
export default function OwnAttendanceRoute() {
  return <AttendanceMonthScreen source={{ kind: 'own' }} secure />;
}
