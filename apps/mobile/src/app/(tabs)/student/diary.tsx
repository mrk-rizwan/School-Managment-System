import { FamilyDiaryScreen } from '../../../family/FamilyScreens';

// /student/diary (slice-16 §5.5): the student's own. Their name heads it: secure.
export default function OwnDiaryRoute() {
  return <FamilyDiaryScreen source={{ kind: 'own' }} secure />;
}
