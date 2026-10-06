import type { TabId } from './tabs';

// The tab ids that have a screen in this build (slice-15 §5, slice-16 §2). A permitted tab with no
// screen yet is simply not shown. Each id is added in the same change as its route folder (a test
// holds the registry, the folders on disk and the tab layout's ROUTES equal). Every tab of
// TAB_ORDER has its screen since 16b.
export const SCREEN_REGISTRY: ReadonlySet<TabId> = new Set<TabId>([
  'home',
  'approvals',
  'classes',
  'today',
  'announce',
  'children',
  'student',
  'inbox',
  'calendar',
  'account',
]);

export const hasScreen = (tab: TabId): boolean => SCREEN_REGISTRY.has(tab);
