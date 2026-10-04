import { RegisterRouteScreen } from '../../../../attendance/RegisterRouteScreen';

// /classes/[sectionId]/register?date&period (slice-16 §4.2). Children's names: secure.
export default function RegisterRoute() {
  return <RegisterRouteScreen secure />;
}
