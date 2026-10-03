import type { Metadata } from 'next';
import { PlatformSettings } from './platform-settings';

export const metadata: Metadata = { title: 'Platform settings' };

export default function PlatformSettingsPage() {
  return <PlatformSettings />;
}
