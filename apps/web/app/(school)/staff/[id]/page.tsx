import type { Metadata } from 'next';
import { StaffDetail } from './staff-detail';

export const metadata: Metadata = { title: 'Staff member' };

// The id is only passed down; the staff record is fetched by the browser (plan §1).
export default async function StaffMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <StaffDetail id={id} />;
}
