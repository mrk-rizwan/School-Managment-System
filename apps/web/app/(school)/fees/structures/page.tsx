import type { Metadata } from 'next';
import { FeeStructureGrid } from './fee-structure-grid';

export const metadata: Metadata = { title: 'Fee structure' };

export default function FeeStructuresPage() {
  return <FeeStructureGrid />;
}
