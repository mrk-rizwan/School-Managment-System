import type { Metadata } from 'next';
import { PlanList } from './plan-list';

export const metadata: Metadata = { title: 'Plans' };

export default function PlansPage() {
  return <PlanList />;
}
