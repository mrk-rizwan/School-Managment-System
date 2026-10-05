import type { Metadata } from 'next';
import { FeeHeadList } from './fee-head-list';

export const metadata: Metadata = { title: 'Fee heads' };

export default function FeeHeadsPage() {
  return <FeeHeadList />;
}
