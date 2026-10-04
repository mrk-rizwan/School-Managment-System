import { useRouter, type Href } from 'expo-router';
import { Screen } from '../../ui/Screen';
import { Sheet } from '../../ui/Sheet';
import { ListRow } from '../../ui/ListRow';
import { TAB_TITLES, useShellTabs } from '../../auth/shell';

// The fifth slot when more than five tabs are shown: the rest, in order (slice-15 §5).
export default function MoreScreen() {
  const router = useRouter();
  const { more } = useShellTabs();
  return (
    <Screen title="More" testID="more.screen">
      <Sheet>
        {more.map((tab) => (
          <ListRow
            key={tab}
            title={TAB_TITLES[tab]}
            onPress={() => router.navigate(`/${tab}` as Href)}
            testID={`more.${tab}`}
          />
        ))}
      </Sheet>
    </Screen>
  );
}
