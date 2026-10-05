import { AttendanceMonthScreen } from '../../../family/FamilyScreens';

// /home/my-attendance (slice-16 §6): the user's own attendance. Not a secure screen.
export default function MyAttendanceRoute() {
  return <AttendanceMonthScreen source={{ kind: 'staff' }} />;
}
