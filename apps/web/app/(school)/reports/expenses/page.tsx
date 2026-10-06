import type { Metadata } from 'next';
import { ExpensesReport } from './expenses-report';

export const metadata: Metadata = { title: 'Expenses report' };

export default function Page() {
  return <ExpensesReport />;
}
