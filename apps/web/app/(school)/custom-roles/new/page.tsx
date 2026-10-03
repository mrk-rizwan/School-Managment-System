import type { Metadata } from 'next';
import { CustomRoleEditor } from '../custom-role-editor';

export const metadata: Metadata = { title: 'New custom role' };

export default function NewCustomRolePage() {
  return <CustomRoleEditor />;
}
