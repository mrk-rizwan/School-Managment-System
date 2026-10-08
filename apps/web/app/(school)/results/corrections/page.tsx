import type { Metadata } from 'next';
import { CorrectionsScreen } from './corrections-screen';

export const metadata: Metadata = { title: 'Mark corrections' };

export default function MarkCorrectionsPage() {
  return <CorrectionsScreen />;
}
