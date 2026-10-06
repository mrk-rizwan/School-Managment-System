import { hasScreen } from './screen-registry';
import { useSession } from './session';
import { composeTabs, layoutTabs, type TabId, type TabLayout } from './tabs';

export const TAB_TITLES: Record<TabId | 'more', string> = {
  home: 'Home',
  approvals: 'Approvals',
  classes: 'Classes',
  today: 'Today',
  announce: 'Announce',
  children: 'Children',
  student: 'My school',
  inbox: 'Inbox',
  calendar: 'Calendar',
  account: 'Account',
  more: 'More',
};

/** The shell's tabs: composeTabs(me) intersected with the screens this build has, laid out. */
export function useShellTabs(): TabLayout {
  const { me } = useSession();
  return layoutTabs(me ? composeTabs(me.body).filter(hasScreen) : []);
}
