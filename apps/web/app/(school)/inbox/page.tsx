import type { Metadata } from 'next';
import { InboxList } from './inbox-list';

export const metadata: Metadata = { title: 'Inbox' };

export default function InboxPage() {
  return <InboxList />;
}
