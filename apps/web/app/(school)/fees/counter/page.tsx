import type { Metadata } from 'next';
import { FeeCounter } from './fee-counter';

export const metadata: Metadata = { title: 'Fee counter' };

export default function Page() {
  return <FeeCounter />;
}
