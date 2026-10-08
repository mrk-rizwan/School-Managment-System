import type { Metadata } from 'next';
import { PromotionHome } from './promotion-home';

export const metadata: Metadata = { title: 'Promotion' };

export default function PromotionPage() {
  return <PromotionHome />;
}
