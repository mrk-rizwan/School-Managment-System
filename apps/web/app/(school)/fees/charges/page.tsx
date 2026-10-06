import type { Metadata } from 'next';
import { ChargeList } from './charge-list';

export const metadata: Metadata = { title: 'Charges' };

export default function ChargesPage() {
  return <ChargeList />;
}
