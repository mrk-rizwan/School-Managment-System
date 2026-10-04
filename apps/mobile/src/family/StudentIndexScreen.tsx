import { useRouter } from 'expo-router';
import { useSession } from '../auth/session';
import { ListRow } from '../ui/ListRow';
import { Screen } from '../ui/Screen';
import { Sheet } from '../ui/Sheet';
import { LoadingState } from '../ui/states';
import { SyncChip } from '../ui/SyncChip';

// "My school" — /student (slice-16 §5.5): the student's own attendance, diary and remarks, the
// same components a parent sees for a child, bound to /me/student.
export function StudentIndexScreen({ secure }: { secure?: boolean }) {
  const router = useRouter();
  const { me } = useSession();
  if (me === null) return <LoadingState />;
  return (
    <Screen
      title={me.body.fullName}
      accessory={<SyncChip />}
      secure={secure}
      testID="student.index"
    >
      <Sheet>
        <ListRow
          title="Attendance"
          onPress={() => router.push('/student/attendance')}
          testID="student.attendance"
        />
        <ListRow
          title="Diary"
          onPress={() => router.push('/student/diary')}
          testID="student.diary"
        />
        <ListRow
          title="Remarks"
          onPress={() => router.push('/student/remarks')}
          testID="student.remarks"
        />
      </Sheet>
    </Screen>
  );
}
