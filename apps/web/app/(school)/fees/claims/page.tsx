import type { Metadata } from 'next';
import { ClaimQueue } from './claim-queue';

export const metadata: Metadata = { title: 'Deposit slips' };

export default function Page() {
  return <ClaimQueue />;
}
