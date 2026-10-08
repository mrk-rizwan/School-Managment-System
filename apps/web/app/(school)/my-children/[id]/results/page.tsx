import type { Metadata } from 'next';
import { ChildResults } from './child-results';

export const metadata: Metadata = { title: "Child's results" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChildResults studentId={id} />;
}
