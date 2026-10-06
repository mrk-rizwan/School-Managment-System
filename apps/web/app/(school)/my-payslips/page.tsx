import type { Metadata } from 'next';
import { MyPayslips } from './my-payslips';

export const metadata: Metadata = { title: 'My payslips' };

export default function MyPayslipsPage() {
  return <MyPayslips />;
}
