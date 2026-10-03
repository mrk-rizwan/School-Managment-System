import type { Metadata } from 'next';
import { UserList } from './user-list';

export const metadata: Metadata = { title: 'User accounts' };

export default function UsersPage() {
  return <UserList />;
}
