import { todayInSchool } from '@asms/shared';
import { useRouter } from 'expo-router';
import type { MyStaffAttendanceDto } from '../api/contracts';
import { useCachedQuery } from '../db/use-cached-query';
import { attendanceMonth } from '../platform/dates';
import { ListRow } from '../ui/ListRow';
import { Sheet } from '../ui/Sheet';
import { staffAttendanceRead } from './source';

// A staff member's own attendance (slice-16 §6, R135): the Home card; the month screen at
// /home/my-attendance is AttendanceMonthScreen. The user's own data: not secure.

/** "October: 18 of 20 working days" — present and late days of the working days so far. */
export function staffCardLine(title: string, data: MyStaffAttendanceDto): string {
  const monthName = title.split(' ')[0];
  return `${monthName}: ${data.present + data.late} of ${data.workingDays} working days`;
}

export function MyAttendanceCard() {
  const router = useRouter();
  const month = attendanceMonth(todayInSchool(), 0);
  const read = staffAttendanceRead(month);
  const query = useCachedQuery(read.key, read.path, read.params, read.fetch);
  const data = query.data?.body;
  return (
    <Sheet testID="home.myAttendance">
      <ListRow
        title="My attendance"
        detail={
          data
            ? staffCardLine(month.title, data)
            : query.isError
              ? 'Not on this phone yet'
              : 'Loading…'
        }
        onPress={() => router.push('/home/my-attendance')}
        testID="home.myAttendance.open"
      />
    </Sheet>
  );
}
