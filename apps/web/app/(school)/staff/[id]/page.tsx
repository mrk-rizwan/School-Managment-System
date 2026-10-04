import type { Metadata } from 'next';
import { StaffDetail } from './staff-detail';

export const metadata: Metadata = { title: 'Staff member' };

// The id is only passed down; the staff record is fetched by the browser (plan §1). `?tab=` only
// preselects a tab ("Arrange cover" on the registers console opens Teaching assignments).
export default async function StaffMemberPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  return <StaffDetail id={id} initialTab={typeof tab === 'string' ? tab : undefined} />;
}
