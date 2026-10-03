import type { Metadata } from 'next';
import { ReadmitForm } from './readmit-form';

export const metadata: Metadata = { title: 'Readmit student' };

export default async function ReadmitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ReadmitForm id={id} />;
}
