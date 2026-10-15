import type { Metadata } from 'next';
import { FinancialStatementReport } from './financial-statement-report';

export const metadata: Metadata = { title: 'Financial statement' };

export default function Page() {
  return <FinancialStatementReport />;
}
