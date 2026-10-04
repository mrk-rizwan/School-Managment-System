import { FamilyRemarksScreen } from '../../../family/FamilyScreens';

// /student/remarks (slice-16 §5.5): the student's own. Their name heads it: secure.
export default function OwnRemarksRoute() {
  return <FamilyRemarksScreen source={{ kind: 'own' }} secure />;
}
