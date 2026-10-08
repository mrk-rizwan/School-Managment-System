import { fireEvent, render, screen } from '@testing-library/react-native';
import { Share } from 'react-native';
import type { ResultDto } from '../api/contracts';
import { ReportCardView, reportCardText } from './ReportCardView';

// Phase 4 slice 32 on the phone: ReportCardView renders ResultDto (the stored row) natively —
// subjects, totals, percentage, position, attendance, remark — marks a revised and a superseded
// card, follows the year's toggles (the API nulls what they hide), and shares the card as text.

const CARD: ResultDto = {
  id: 'r1',
  sheetId: 'rs1',
  sheetVersion: 1,
  schoolName: 'Green Valley School',
  academicYearId: 'y1',
  academicYearName: '2026-27',
  termId: 't1',
  termName: 'Mid-term',
  isFinal: false,
  classId: 'c5',
  className: 'Class 5',
  sectionId: 'sec-a',
  sectionName: 'A',
  enrolmentId: 'e1',
  studentId: 'st1',
  studentName: 'Zara Khan',
  admissionNo: '1001',
  rollNo: 1,
  totalObtained: 149,
  totalMax: 200,
  percentBp: 7450,
  grade: 'B',
  passed: true,
  failedSubjects: 0,
  position: 1,
  positionOf: 2,
  attendanceBp: 9230,
  remark: 'A careful worker.',
  showPosition: true,
  showAttendance: true,
  showRemark: true,
  revised: false,
  publishedAt: '2026-10-06T05:00:00.000Z',
  supersededAt: null,
  subjects: [
    {
      classSubjectId: 'cs-m',
      subjectName: 'Mathematics',
      sortOrder: 1,
      testBp: 7500,
      examBp: 8000,
      examObtained: 80,
      examMax: 100,
      examAbsent: false,
      examExcused: false,
      percentBp: 7900,
      obtained: 79,
      max: 100,
      grade: 'B',
      status: 'assessed',
    },
    {
      classSubjectId: 'cs-e',
      subjectName: 'English',
      sortOrder: 2,
      testBp: null,
      examBp: null,
      examObtained: null,
      examMax: 100,
      examAbsent: true,
      examExcused: true,
      percentBp: null,
      obtained: null,
      max: 100,
      grade: null,
      status: 'not_assessed',
    },
  ],
};

describe('ReportCardView', () => {
  it('renders the stored row: subjects, totals, percentage, position, attendance and remark', () => {
    render(<ReportCardView result={CARD} />);
    expect(screen.getByText('Green Valley School')).toBeTruthy();
    expect(screen.getByText('Report card · Mid-term · 2026-27')).toBeTruthy();
    expect(screen.getByTestId('reportCard.subject.cs-m')).toHaveTextContent('Mathematics79 / 100B');
    expect(screen.getByTestId('reportCard.subject.cs-e')).toHaveTextContent('English (Ex)——');
    expect(screen.getByTestId('reportCard.legend')).toHaveTextContent(/^Ab: absent from the exam, counted as 0\. Ex:/);
    expect(screen.getByTestId('reportCard.percent')).toHaveTextContent('74.50 % · Passed');
    expect(screen.getByTestId('reportCard.position')).toHaveTextContent('Position 1 / 2');
    expect(screen.getByText('Attendance 92.30 %')).toBeTruthy();
    expect(screen.getByText('“A careful worker.”')).toBeTruthy();
    expect(screen.queryByTestId('reportCard.revised')).toBeNull();
    expect(screen.toJSON()).toMatchSnapshot();
  });

  it('hides what the toggles hide, and marks a revised and a superseded card', () => {
    const hidden: ResultDto = {
      ...CARD,
      position: null,
      positionOf: null,
      attendanceBp: null,
      remark: null,
      showPosition: false,
      showAttendance: false,
      showRemark: false,
      revised: true,
    };
    const { rerender } = render(<ReportCardView result={hidden} />);
    expect(screen.queryByTestId('reportCard.position')).toBeNull();
    expect(screen.queryByText(/Attendance/)).toBeNull();
    expect(screen.getByTestId('reportCard.revised')).toHaveTextContent(/Revised on/);
    rerender(<ReportCardView result={{ ...hidden, supersededAt: '2026-10-07T05:00:00.000Z' }} />);
    expect(screen.getByTestId('reportCard.superseded')).toBeTruthy();
    expect(screen.queryByTestId('reportCard.revised')).toBeNull();
  });

  it('shares the card as text', () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
    render(<ReportCardView result={CARD} />);
    fireEvent.press(screen.getByTestId('reportCard.share'));
    expect(share).toHaveBeenCalledWith({ message: reportCardText(CARD) });
    expect(reportCardText(CARD)).toContain('Mathematics: 79 / 100 (B)');
    expect(reportCardText(CARD)).toContain('English (Ex): —');
    expect(reportCardText(CARD)).toContain('Ab: absent from the exam, counted as 0.');
    expect(reportCardText(CARD)).toContain('Total: 149 / 200 · 74.50 % · Grade B');
  });

  it('prints "Ab" for an unexcused exam absence, and no legend when no subject carries a marker (rule 26)', () => {
    const [maths, english] = CARD.subjects;
    const absent: ResultDto = {
      ...CARD,
      subjects: [
        maths!,
        { ...english!, examAbsent: true, examExcused: false, testBp: 6000, examBp: 0, percentBp: 1200, obtained: 12, grade: 'F', status: 'assessed' },
      ],
    };
    const { rerender } = render(<ReportCardView result={absent} />);
    expect(screen.getByTestId('reportCard.subject.cs-e')).toHaveTextContent('English (Ab)12 / 100F');
    expect(screen.getByTestId('reportCard.legend')).toBeTruthy();
    expect(reportCardText(absent)).toContain('English (Ab): 12 / 100 (F)');
    rerender(<ReportCardView result={{ ...CARD, subjects: [maths!] }} />);
    expect(screen.queryByTestId('reportCard.legend')).toBeNull();
    expect(reportCardText({ ...CARD, subjects: [maths!] })).not.toContain('Ab:');
  });
});
