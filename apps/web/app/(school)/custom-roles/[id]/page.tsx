import type { Metadata } from 'next';
import { CustomRoleEditor } from '../custom-role-editor';

export const metadata: Metadata = { title: 'Custom role' };

// The id is only passed down; the role is fetched by the browser (plan §1).
export default async function CustomRolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomRoleEditor id={id} />;
}
