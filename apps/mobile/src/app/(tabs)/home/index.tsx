import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useSession } from '../../../auth/session';
import { ExpensesCard } from '../../../expenses/ExpensesCard';
import { MyAttendanceCard } from '../../../family/MyAttendance';
import { MyLeaveCard } from '../../../leave/MyLeave';
import { useOnline } from '../../../net/connectivity';
import { Banner } from '../../../ui/Banner';
import { Screen } from '../../../ui/Screen';
import { AsOf, LoadingState, OfflineNotice } from '../../../ui/states';
import { SyncChip } from '../../../ui/SyncChip';
import { colors, fontSize, space } from '../../../ui/theme';

// Home (slice-15 §14 task 15.2): who is signed in, at which school, as of when. Slice 16 adds
// the staff card "My attendance" (§6); the role tabs carry their own screens.
export default function HomeScreen() {
  const router = useRouter();
  const session = useSession();
  const online = useOnline();
  const me = session.me;
  if (me === null) return <LoadingState />;

  const banners = (
    <View style={styles.banners}>
      {!online || session.meStale ? (
        <OfflineNotice serverTime={me.serverTime} isDevice={me.serverTimeIsDevice} />
      ) : null}
      {session.discardedNotice !== null ? (
        <Banner
          testID="home.discarded"
          tone="warning"
          text={session.discardedNotice}
          onDismiss={session.dismissDiscardedNotice}
        />
      ) : null}
      {me.body.passwordIsDefault && !session.bannerDismissed ? (
        <Banner
          testID="home.defaultPassword"
          tone="warning"
          text="You are using the default password. Change it."
          actionLabel="Change password"
          onAction={() => router.push('/account/change-password')}
          onDismiss={session.dismissBanner}
        />
      ) : null}
    </View>
  );

  return (
    <Screen title="Home" accessory={<SyncChip />} banner={banners} testID="home.screen">
      <View style={styles.card}>
        <Text style={styles.name} testID="home.fullName">
          {me.body.fullName}
        </Text>
        <Text style={styles.school} testID="home.schoolName">
          {me.body.school.name}
        </Text>
        <AsOf serverTime={me.serverTime} isDevice={me.serverTimeIsDevice} />
      </View>
      {me.body.capacities.includes('staff') ? <MyAttendanceCard /> : null}
      {me.body.capacities.includes('staff') ? <MyLeaveCard /> : null}
      <ExpensesCard />
    </Screen>
  );
}

const styles = StyleSheet.create({
  banners: { gap: space.sm },
  card: { gap: space.xs },
  name: { fontSize: fontSize.title, fontWeight: '600', color: colors.foreground },
  school: { fontSize: fontSize.body, color: colors.mutedForeground },
});
