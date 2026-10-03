import type { Metadata } from 'next';
import { SchoolSettings } from './school-settings';

export const metadata: Metadata = { title: 'School settings' };

export default function SettingsPage() {
  return <SchoolSettings />;
}
