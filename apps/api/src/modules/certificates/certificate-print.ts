// The certificate's print view (phase-4-academic.md slice 34, §3.4, §7.1; contracts/slice-34.md
// §4): one scriptless, auto-escaped layout for the five types, sent only through sendPrintView.
// Every value comes from the stored body snapshot except the issuer's name, the void stamp and the
// B-Form number, which the handler decrypts for a non-voided leaving certificate with
// certificate_show_identity_no on and passes here; it is never stored, logged or returned as JSON.
import { certificateLabel, type StudentStatus } from '@asms/shared';
import { html, printPage, type SafeHtml } from '../../common/print-view';
import type { CertificateBody } from '../../repositories/certificate.repository';
import type { CertificateDto } from './certificates.dto';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const day = (iso: string): string => DAY.format(new Date(`${iso}T00:00:00Z`));

/** How the leaving certificate names the way the student left. */
const LEFT_AS: Readonly<Partial<Record<StudentStatus, string>>> = {
  withdrawn: 'Withdrawn by the family',
  transferred: 'Transferred to another school',
  alumni: 'Completed the final class',
};

/** `3520112345671` → `35201-2345671-1`, as a B-Form is written. */
const dashedIdentity = (digits: string): string => `${digits.slice(0, 5)}-${digits.slice(5, 12)}-${digits.slice(12)}`;

/** "son of Tariq Mehmood, " or "" when no father is recorded. */
function parentage(body: CertificateBody): string {
  if (body.fatherName === null) return '';
  return `${body.gender === 'female' ? 'daughter' : 'son'} of ${body.fatherName}, `;
}

function placeOf(body: CertificateBody): string {
  if (body.className === null) return '';
  return `${body.className}${body.sectionName === null ? '' : ` ${body.sectionName}`}`;
}

/** The certifying sentence of each type. */
function statement(cert: CertificateDto): SafeHtml {
  const b = cert.body;
  const who = html`<strong>${b.studentName}</strong>, ${parentage(b)}admission no. ${b.admissionNo}`;
  const from = b.attendedFrom === null ? null : day(b.attendedFrom);
  const to = b.attendedTo === null ? 'date' : day(b.attendedTo);
  const period = from === null ? html`` : html` from ${from} to ${to}`;
  const year = b.academicYearName === null ? '' : ` in the academic year ${b.academicYearName}`;
  const place = placeOf(b);
  switch (cert.type) {
    case 'leaving':
      return html`<p>This is to certify that ${who}, was a student of this school${period}.${place === '' ? '' : ` At leaving the student was in class ${place}${year}.`}</p>`;
    case 'character':
      return html`<p>This is to certify that ${who}, has been a student of this school${period}. To the best of our knowledge the student bears a good moral character.</p>`;
    case 'academic':
      return html`<p>This is to certify that ${who}, studied in this school${place === '' ? '' : ` in class ${place}`}${year}.</p>`;
    case 'completion':
      return html`<p>This is to certify that ${who}, has completed${place === '' ? ' the course of study' : ` class ${place}`} at this school${year}.</p>`;
    case 'other':
      return html`<p>This is to certify that ${who}, ${b.attendedTo === null ? 'is' : 'was'} a student of this school${period}.</p>`;
  }
}

function detailRows(cert: CertificateDto, identityNumber: string | null): SafeHtml[] {
  const b = cert.body;
  const row = (label: string, value: string | null) =>
    value === null || value === '' ? null : html`<tr><th>${label}</th><td>${value}</td></tr>`;
  const rows = [
    row('Student', b.studentName),
    row(b.gender === 'female' ? 'Daughter of' : 'Son of', b.fatherName),
    row('Admission no.', b.admissionNo),
    cert.type === 'leaving' ? row('B-Form no.', identityNumber === null ? null : dashedIdentity(identityNumber)) : null,
    row('Date of birth', day(b.dateOfBirth)),
    row('Admitted on', day(b.admittedOn)),
    row('Class', placeOf(b)),
    row('Academic year', b.academicYearName),
    cert.type === 'leaving' ? row('Left on', b.attendedTo === null ? null : day(b.attendedTo)) : null,
    cert.type === 'leaving' ? row('Reason for leaving', LEFT_AS[b.studentStatus] ?? null) : null,
    row('Conduct', b.conduct),
    row('Remarks', b.remarks),
  ];
  return rows.filter((r): r is SafeHtml => r !== null);
}

function history(cert: CertificateDto): SafeHtml {
  // The class history belongs on the leaving, academic and completion certificates.
  if (cert.type === 'character' || cert.type === 'other' || cert.body.enrolments.length === 0) return html``;
  // TODO(wave O, contracts/slice-34.md §3): academic and completion certificates add the marks
  // table of the published result here once results exist.
  const rows = cert.body.enrolments.map(
    (e) => html`<tr><td>${e.academicYearName}</td><td>${e.className} ${e.sectionName}</td><td>${day(e.from)}</td><td>${e.to === null ? '' : day(e.to)}</td></tr>`,
  );
  return html`<h3>Record of attendance</h3>
<table>
  <tr><th>Academic year</th><th>Class</th><th>From</th><th>To</th></tr>
  ${rows}
</table>`;
}

/**
 * The page. `identityNumber` is the decrypted B-Form digits or null; the caller passes it only for
 * a non-voided leaving certificate with the setting on (R292).
 */
export function certificatePage(cert: CertificateDto, identityNumber: string | null): SafeHtml {
  const label = certificateLabel(cert.type, cert.number);
  const body = html`<style>
  .cert { max-width: 720px; margin: 0 auto; }
  .cert h1, .cert h2 { text-align: center; margin: 4px 0; }
  .cert .meta { display: flex; justify-content: space-between; margin: 16px 0; }
  .cert .stamp { text-align: center; font-weight: 700; letter-spacing: 4px; border: 2px solid #111; padding: 4px; }
  .cert .void { text-align: center; font-weight: 700; border: 2px solid #b91c1c; color: #b91c1c; padding: 8px; }
  .cert .lead { font-size: 15px; line-height: 1.7; margin: 16px 0; }
  .cert .sign { display: flex; justify-content: space-between; margin-top: 64px; }
  .cert .sign div { min-width: 220px; text-align: center; border-top: 1px solid #111; padding-top: 4px; }
</style>
<div class="cert">
<h1>${cert.body.schoolName}</h1>
<h2>${cert.title}</h2>
<div class="meta"><span>No. ${label}${cert.issueNo > 1 ? ` (issue ${cert.issueNo})` : ''}</span><span>Issued on ${day(cert.issuedOn)}</span></div>
${cert.issueNo > 1 ? html`<p class="stamp">DUPLICATE</p>` : html``}
${cert.voidedAt === null ? html`` : html`<p class="void">VOID: this certificate was cancelled${cert.voidReason === null ? '' : ` (${cert.voidReason})`} and is no longer valid.</p>`}
<div class="lead">${statement(cert)}</div>
<table>
  ${detailRows(cert, identityNumber)}
</table>
${history(cert)}
<div class="sign">
  <div>Issued by ${cert.issuedByName}</div>
  <div>${cert.body.signatoryName}<br>Authorised signatory</div>
</div>
</div>`;
  return printPage(`${cert.title} ${label}`, body);
}
