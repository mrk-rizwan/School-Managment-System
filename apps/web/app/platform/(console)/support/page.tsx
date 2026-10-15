import type { Metadata } from 'next';
import { SupportSessionList } from './support-session-list';

export const metadata: Metadata = { title: 'Support access' };

export default function SupportPage() {
  return <SupportSessionList />;
}
