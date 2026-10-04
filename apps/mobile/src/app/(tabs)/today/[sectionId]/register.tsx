import { RegisterRouteScreen } from '../../../../attendance/RegisterRouteScreen';

// /today/[sectionId]/register?date&period: the same register in Today's stack, so a principal's
// back returns to Today (review M2; slice-16 §7.1 "Record now"). Children's names: secure.
export default function TodayRegisterRoute() {
  return <RegisterRouteScreen secure />;
}
