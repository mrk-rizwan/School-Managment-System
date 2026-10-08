// The report card's print view (phase-4-academic.md §3.4, R279, R283, R284; contracts/slice-32.md
// §3): one scriptless, auto-escaped layout, sent only through sendPrintView. Every figure is the
// stored row's (ResultDto); the year's display toggles have already nulled what they hide. A sheet
// prints its live cards one per page.
import { formatPercentBp } from '@asms/shared';
import { html, printPage, type SafeHtml } from '../../common/print-view';
import type { ResultDto } from './results.dto';

const percent = (bp: number | null): string => (bp === null ? '—' : `${formatPercentBp(bp)} %`);

function dayIn(timezone: string, at: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: timezone,
  }).format(at);
}

function subjectRow(s: ResultDto['subjects'][number]): SafeHtml {
  const assessed = s.status === 'assessed';
  return html`<tr>
  <td>${s.subjectName}</td>
  <td class="amount">${assessed && s.obtained !== null ? s.obtained : '—'}</td>
  <td class="amount">${s.max}</td>
  <td class="amount">${assessed ? percent(s.percentBp) : '—'}</td>
  <td>${assessed ? (s.grade ?? '') : '—'}</td>
</tr>`;
}

/** One card. `timezone` dates the "Revised" stamp in the school's day. */
export function resultCard(card: ResultDto, timezone: string): SafeHtml {
  const term = card.isFinal ? 'Final result' : (card.termName ?? '');
  const stamp =
    card.supersededAt !== null
      ? html`<p class="stamp superseded">SUPERSEDED: a corrected version of this result exists</p>`
      : card.revised && card.publishedAt !== null
        ? html`<p class="stamp">Revised on ${dayIn(timezone, card.publishedAt)}</p>`
        : html``;
  const position =
    card.showPosition && card.position !== null && card.positionOf !== null
      ? html`<tr><th>Position</th><td>${card.position} / ${card.positionOf}</td></tr>`
      : html``;
  const attendance = card.showAttendance
    ? html`<tr><th>Attendance</th><td>${percent(card.attendanceBp)}</td></tr>`
    : html``;
  const remark =
    card.showRemark && card.remark !== null
      ? html`<h3>Class teacher's remark</h3><p class="remark">${card.remark}</p>`
      : html``;
  const verdict = card.passed === null ? '—' : card.passed ? 'Passed' : 'Not passed';
  return html`<section class="card">
<h1>${card.schoolName}</h1>
<h2>Report card · ${term} · ${card.academicYearName}</h2>
${stamp}
<table class="who">
  <tr><th>Student</th><td>${card.studentName}</td><th>Admission no.</th><td>${card.admissionNo}</td></tr>
  <tr><th>Class</th><td>${card.className} ${card.sectionName}</td><th>Roll no.</th><td>${card.rollNo === null ? '—' : card.rollNo}</td></tr>
</table>
<table class="marks">
  <tr><th>Subject</th><th class="amount">Obtained</th><th class="amount">Max</th><th class="amount">Percentage</th><th>Grade</th></tr>
  ${card.subjects.map(subjectRow)}
  <tr class="total"><th>Total</th><th class="amount">${card.totalObtained}</th><th class="amount">${card.totalMax}</th><th class="amount">${percent(card.percentBp)}</th><th>${card.grade ?? '—'}</th></tr>
</table>
<table class="summary">
  <tr><th>Result</th><td>${verdict}</td></tr>
  ${position}
  ${attendance}
</table>
${remark}
<div class="sign"><div>Class teacher</div><div>Principal</div></div>
</section>`;
}

const STYLE = html`<style>
  .card { max-width: 760px; margin: 0 auto; page-break-after: always; break-after: page; }
  .card:last-child { page-break-after: auto; break-after: auto; }
  .card h1, .card h2 { text-align: center; margin: 4px 0; }
  .card table { margin: 12px 0; }
  .card .total th { border-top: 2px solid #111; }
  .card .stamp { text-align: center; font-weight: 700; border: 2px solid #111; padding: 4px; }
  .card .stamp.superseded { border-color: #b91c1c; color: #b91c1c; }
  .card .remark { border: 1px solid #ddd; padding: 8px; }
  .card .sign { display: flex; justify-content: space-between; margin-top: 56px; }
  .card .sign div { min-width: 200px; text-align: center; border-top: 1px solid #111; padding-top: 4px; }
</style>`;

/** A single card (GET /results/:id/print). */
export function resultCardPage(card: ResultDto, timezone: string): SafeHtml {
  return printPage(
    `Report card ${card.studentName}`,
    html`${STYLE}${resultCard(card, timezone)}`,
  );
}

/** A sheet's live cards, one per page (GET /result-sheets/:id/print). */
export function resultSheetPage(
  title: string,
  cards: readonly ResultDto[],
  timezone: string,
): SafeHtml {
  const body =
    cards.length === 0
      ? html`<p>No results are stored on this sheet.</p>`
      : cards.map((card) => resultCard(card, timezone));
  return printPage(title, html`${STYLE}${body}`);
}
