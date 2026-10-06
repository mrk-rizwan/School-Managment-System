import type { Metadata } from 'next';
import { PageHeader } from '@/components/app-shell';
import { ExpenseList } from './expense-list';

export const metadata: Metadata = { title: 'Expenses' };

// Expenses (phase-3-financial.md slice 23). Data is fetched by the browser (plan §1).
export default function ExpensesPage() {
  return (
    <>
      <PageHeader
        title="Expenses"
        description="What the school spends. Above the approval threshold an expense waits for a principal."
      />
      <ExpenseList />
    </>
  );
}
