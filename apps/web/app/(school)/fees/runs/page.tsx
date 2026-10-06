import type { Metadata } from 'next';
import { RunList } from './run-list';

export const metadata: Metadata = { title: 'Generation runs' };

export default function RunsPage() {
  return <RunList />;
}
