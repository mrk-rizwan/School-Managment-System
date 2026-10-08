import type { Metadata } from 'next';
import { ResultSheetScreen } from './result-sheet';

export const metadata: Metadata = { title: 'Result sheet' };

export default async function ResultSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ResultSheetScreen id={id} />;
}
