import { useLocalSearchParams } from 'expo-router';
import { RegisterScreen } from './RegisterScreen';

/**
 * The register route's body (slice-16 §4.2): `?date&period` checked, then the register. Hosted
 * at /classes/[sectionId]/register and, for a principal's "Record now", at
 * /today/[sectionId]/register so back returns to Today (review M2).
 */
export function RegisterRouteScreen({ secure }: { secure: boolean }) {
  const params = useLocalSearchParams<{ sectionId: string; date?: string; period?: string }>();
  const date = params.date && /^\d{4}-\d{2}-\d{2}$/.test(params.date) ? params.date : undefined;
  const period = /^[1-9]\d?$/.test(params.period ?? '') ? Number(params.period) : undefined;
  return <RegisterScreen sectionId={params.sectionId} date={date} period={period} secure={secure} />;
}
