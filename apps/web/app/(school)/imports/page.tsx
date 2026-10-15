import type { Metadata } from 'next';
import { ImportsHome } from './imports-home';

export const metadata: Metadata = { title: 'Imports' };

// Commencement imports (Phase 5 slice 43, rule 39): past results and opening balances, each
// previewed then committed. Data is fetched by the browser (plan §1).
export default function ImportsPage() {
  return <ImportsHome />;
}
