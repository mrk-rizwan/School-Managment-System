import type { Metadata } from 'next';
import { CustomRoleList } from './custom-role-list';

export const metadata: Metadata = { title: 'Custom roles' };

export default function CustomRolesPage() {
  return <CustomRoleList />;
}
