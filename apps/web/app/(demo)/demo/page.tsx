import type { Metadata } from 'next';
import { Demo } from './demo';

export const metadata: Metadata = { title: 'Component demo' };

// THROWAWAY (slice 0.7): exercises the shared components with fake data and no network.
// Delete this folder and its nav entry once real screens use the components.
export default function DemoPage() {
  return <Demo />;
}
