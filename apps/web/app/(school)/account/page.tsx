import type { Metadata } from 'next';
import { Account } from './account';

export const metadata: Metadata = { title: 'Your account' };

export default function AccountPage() {
  return <Account />;
}
