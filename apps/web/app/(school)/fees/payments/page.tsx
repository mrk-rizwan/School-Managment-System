import type { Metadata } from 'next';
import { PaymentList } from './payment-list';

export const metadata: Metadata = { title: 'Payments' };

export default function Page() {
  return <PaymentList />;
}
