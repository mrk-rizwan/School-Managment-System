import type { Metadata } from 'next';
import { EndingContracts } from './ending-contracts';

export const metadata: Metadata = { title: 'Contracts ending' };

export default function EndingContractsPage() {
  return <EndingContracts />;
}
