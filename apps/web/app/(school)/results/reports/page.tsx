import type { Metadata } from 'next';
import { ResultReports } from './result-reports';

export const metadata: Metadata = { title: 'Result reports' };

// contracts/slice-33.md §5: read by the browser with marks.view_all; no school data on the server.
export default function ResultReportsPage() {
  return <ResultReports />;
}
