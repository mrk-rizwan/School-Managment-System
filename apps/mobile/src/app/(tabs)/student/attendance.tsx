import { FamilyAttendanceScreen } from '../../../family/FamilyScreens';

// /student/attendance (slice-16 §5.5): the student's own. Their name heads it: secure.
export default function OwnAttendanceRoute() {
  return <FamilyAttendanceScreen source={{ kind: 'own' }} secure />;
}
