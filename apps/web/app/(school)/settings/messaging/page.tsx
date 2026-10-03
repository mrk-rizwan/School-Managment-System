import type { Metadata } from 'next';
import { MessagingSettings } from './messaging-settings';

export const metadata: Metadata = { title: 'Messaging' };

export default function MessagingSettingsPage() {
  return <MessagingSettings />;
}
