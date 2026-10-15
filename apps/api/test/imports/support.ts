// Slice 43 test support (contracts/slice-43.md): the multipart preview call, the keyed commit, the
// DTO shapes the suites read back, and a CSV builder.
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { newIdempotencyKey } from '@asms/shared';
import { loadEnv } from '../../src/config/env';

export const API = '/api/v1';
export const ORIGIN = new URL(loadEnv().APP_URL).origin;

export interface ImportRowError {
  row: number;
  field: string;
  code: string;
  admissionNo?: string;
}

export interface ImportDetail {
  id: string;
  kind: 'past_results' | 'opening_balances';
  status: 'previewed' | 'committed' | 'failed';
  fileName: string;
  rowCount: number;
  academicYearId: string;
  sectionId: string | null;
  termId: string | null;
  dueOn: string | null;
  createdByName: string;
  committedByName: string | null;
  error: string | null;
  errorCount: number;
  errors: ImportRowError[];
  subjects: { classSubjectId: string; name: string; maxMarks: number }[];
  rows: {
    row: number;
    studentId: string;
    admissionNo: string;
    studentName: string;
    marks: { classSubjectId: string; obtained: number | null }[] | null;
    amount: number | null;
    note: string | null;
    advance: number | null;
  }[];
  totalAmount: number | null;
  totalAdvance: number | null;
  resultSheetId: string | null;
}

export interface ErrorEnvelope {
  error: { code: string; details: (Record<string, unknown> & { fields?: { path: string; code: string }[] }) | null };
}
export const errorOf = (res: request.Response) => (res.body as ErrorEnvelope).error;

/** CSV text (LF line ends) from rows of cells. */
export const csv = (...rows: (readonly (string | number)[])[]): string => `${rows.map((r) => r.join(',')).join('\n')}\n`;

export function importsHttp(app: () => NestExpressApplication) {
  const http = () => request(app().getHttpServer());

  /** A multipart preview: the text fields, then the CSV as `file`. */
  const preview = (
    kind: 'past-results' | 'opening-balances',
    fields: Record<string, string>,
    content: string | Buffer,
    cookie: string,
    opts: { key?: string; fileName?: string } = {},
  ) => {
    const req = http()
      .post(`${API}/imports/${kind}`)
      .set('Cookie', cookie)
      .set('Origin', ORIGIN)
      .set('Idempotency-Key', opts.key ?? newIdempotencyKey());
    for (const [name, value] of Object.entries(fields)) req.field(name, value);
    return req.attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'), opts.fileName ?? 'import.csv');
  };

  const commit = (id: string, cookie: string, key: string = newIdempotencyKey()) =>
    http().post(`${API}/imports/${id}/commit`).set('Cookie', cookie).set('Origin', ORIGIN).set('Idempotency-Key', key).send();

  const get = (path: string, cookie: string) => http().get(`${API}${path}`).set('Cookie', cookie);

  return { http, preview, commit, get };
}
