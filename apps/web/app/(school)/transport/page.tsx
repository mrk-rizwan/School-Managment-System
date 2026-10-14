import type { Metadata } from 'next';
import { RouteList } from './route-list';

export const metadata: Metadata = { title: 'Transport' };

export default function TransportPage() {
  return <RouteList />;
}
