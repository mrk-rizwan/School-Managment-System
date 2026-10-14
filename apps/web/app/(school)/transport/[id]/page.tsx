import type { Metadata } from 'next';
import { RouteDetail } from './route-detail';

export const metadata: Metadata = { title: 'Transport route' };

export default async function RoutePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RouteDetail id={id} />;
}
