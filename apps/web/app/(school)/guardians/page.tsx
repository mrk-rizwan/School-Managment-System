import type { Metadata } from 'next';
import { GuardianList } from './guardian-list';

export const metadata: Metadata = { title: 'Guardians' };

export default function GuardiansPage() {
  return <GuardianList />;
}
