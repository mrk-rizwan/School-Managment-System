import type { Metadata } from 'next';
import { PromotionSheet } from './promotion-sheet';

export const metadata: Metadata = { title: 'Promotion sheet' };

export default async function PromotionSheetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PromotionSheet id={id} />;
}
