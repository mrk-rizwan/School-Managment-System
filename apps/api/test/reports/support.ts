// Phase 5 slice 42 (contracts/slice-42.md §3, R336): the CSV helpers the report suites share — a
// same-site CSV request and an RFC 4180 reader for what came back.
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { API } from '../payments/payments-support';

/** GET `path` (`?…&format=csv` included by the caller) as the web's own tab would send it. */
export function csvGet(
  app: NestExpressApplication,
  path: string,
  cookie: string,
  site: 'same-origin' | 'cross-site' | null = 'same-origin',
): request.Test {
  const req = request(app.getHttpServer()).get(`${API}${path}`).set('Cookie', cookie);
  if (site !== null) req.set('Sec-Fetch-Site', site);
  return req;
}

/** The records of a CSV text: quotes, doubled quotes and CRLF handled; the final newline dropped. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      cells.push(cell);
      records.push(cells);
      cells = [];
      cell = '';
      i += 1;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) {
    cells.push(cell);
    records.push(cells);
  }
  return records;
}

/** The school's today as the API's file name uses it (Asia/Karachi). */
export const karachiToday = (): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());

/** The checks every CSV answer carries (R336): type, fixed ASCII name, no-store. */
export function expectCsvHeaders(res: request.Response, report: string): void {
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
  expect(res.headers['content-disposition']).toBe(`attachment; filename="${report}-${karachiToday()}.csv"`);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.headers['x-content-type-options']).toBe('nosniff');
}
