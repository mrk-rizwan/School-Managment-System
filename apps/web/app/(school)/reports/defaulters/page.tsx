import type { Metadata } from 'next';
import { DefaultersReport } from './defaulters-report';

export const metadata: Metadata = { title: 'Defaulters' };

export default function Page() {
  return <DefaultersReport />;
}
