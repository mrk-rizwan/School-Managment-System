import type { TabId } from './tabs';

// The tab ids that have a screen in this build (slice-15 §5). A permitted tab with no screen yet
// is simply not shown. Slice 16 adds classes, today, announce, children, student and inbox here
// together with their route folders.
export const SCREEN_REGISTRY: ReadonlySet<TabId> = new Set<TabId>(['home', 'calendar', 'account']);

export const hasScreen = (tab: TabId): boolean => SCREEN_REGISTRY.has(tab);
