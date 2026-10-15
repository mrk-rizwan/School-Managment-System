import type { Metadata } from 'next';
import { SupportSessionViews } from './support-session-views';

export const metadata: Metadata = { title: 'Support session' };

export default async function SupportSessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SupportSessionViews id={id} />;
}
