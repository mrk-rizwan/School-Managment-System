import type { Metadata } from 'next';
import { DeliveryHealth } from './delivery-health';

export const metadata: Metadata = { title: 'Delivery health' };

export default function DeliveryHealthPage() {
  return <DeliveryHealth />;
}
