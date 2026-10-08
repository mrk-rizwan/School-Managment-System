import { FamilyResultsScreen } from '../../../../family/FamilyResults';

// /student/results (slice 33): the student's own published results and class tests. Secure.
export default function OwnResultsRoute() {
  return <FamilyResultsScreen source={{ kind: 'own' }} secure />;
}
