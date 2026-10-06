import type { Metadata } from 'next';
import { PayrollScreen } from './payroll-screen';

export const metadata: Metadata = { title: 'Payroll' };

export default function PayrollPage() {
  return <PayrollScreen />;
}
