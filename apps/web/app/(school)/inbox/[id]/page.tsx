import type { Metadata } from 'next';
import { InboxItem } from './inbox-item';

export const metadata: Metadata = { title: 'Message' };

// `id` is the messages row id, the same one a push deep-link carries (contracts/slice-14.md §7.4).
export default async function InboxItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InboxItem id={id} />;
}
