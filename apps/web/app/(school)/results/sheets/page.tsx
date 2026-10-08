import type { Metadata } from 'next';
import { ResultsHome } from './results-home';

export const metadata: Metadata = { title: 'Result sheets' };

export default function ResultSheetsPage() {
  return <ResultsHome />;
}
