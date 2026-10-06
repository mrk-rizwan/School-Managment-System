import type { Metadata } from 'next';
import { PayrollReport } from './payroll-report';

export const metadata: Metadata = { title: 'Payroll report' };

export default function Page() {
  return <PayrollReport />;
}
