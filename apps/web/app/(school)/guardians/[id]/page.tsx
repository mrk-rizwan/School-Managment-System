import type { Metadata } from 'next';
import { GuardianDetail } from './guardian-detail';

export const metadata: Metadata = { title: 'Guardian' };

// The id is only passed down; the guardian is fetched by the browser (plan §1).
export default async function GuardianPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GuardianDetail id={id} />;
}
