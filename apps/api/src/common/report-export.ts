// Phase 5 slice 42 (phase-5-extended.md §1.1 "CSV", §7.1; contracts/slice-42.md §3; R336): every
// report route's `?format=csv`, written once. A route opts in with @CsvExport (the columns, the
// audit family, the report slug); its query DTO declares `format` with @CsvFormatField; its
// family's throttle counts a CSV request as 5 (csvCost). The interceptor refuses page/limit with
// format=csv, refuses a cross-site request (the print views' same-site rule), turns the handler's
// own JSON body into the rows shown, refuses more than CSV_MAX_ROWS, writes the audited
// `<family>.exported { report, filters, rowCount }` row (the one write a report GET makes), and
// sends `text/csv` under a fixed ASCII file name.

import {
  applyDecorators,
  Injectable,
  SetMetadata,
  UseInterceptors,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiProduces, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { Request, Response } from 'express';
import { from, mergeMap, type Observable } from 'rxjs';
import { CSV_MAX_ROWS, csvFileName, ErrorCode, toCsv, type CsvColumn } from '@asms/shared';
import { AuditLogRepository } from '../repositories/audit-log.repository';
import { fieldRefused } from './errors/api-exception';
import { SameSitePrintGuard } from './print-view';
import type { RequestCost } from './rate-limit';
import { SchoolClock } from './school-clock';
import { SchoolContext } from './school-context';

export const CSV_FORMATS = ['csv'] as const;
export type CsvFormat = (typeof CSV_FORMATS)[number];

/** What a CSV request costs in its family's throttle (R336); a JSON request costs one. */
export const CSV_COST = 5;

/** The family throttles' cost function: `?format=csv` counts five hits. */
export const csvCost: RequestCost = (req) => (req.query?.format === 'csv' ? CSV_COST : 1);

/** The `format` query field of a report: absent (JSON) or `csv`. */
export const CsvFormatField = (): PropertyDecorator =>
  applyDecorators(
    ApiPropertyOptional({
      enum: CSV_FORMATS,
      enumName: 'ReportFormat',
      description: 'csv: the rows shown as a CSV download (no page or limit; at most 10,000 rows; audited)',
    }),
    IsOptional(),
    IsIn(CSV_FORMATS),
  );

/** The query of a report that takes nothing but the format. */
export class CsvQueryDto {
  @CsvFormatField() format?: CsvFormat;
}

/**
 * The rows a paged report reads: the requested page, or, for a CSV export, every row up to one
 * past the cap (so the interceptor can tell an export that is too large).
 */
export function pageWindow(query: { page: number; limit: number; format?: CsvFormat }): { skip: number; take: number } {
  return query.format === 'csv'
    ? { skip: 0, take: CSV_MAX_ROWS + 1 }
    : { skip: (query.page - 1) * query.limit, take: query.limit };
}

/** The audit family of an export: `<family>.exported`. */
export type ExportFamily =
  | 'finance_report'
  | 'result_report'
  | 'staff_report'
  | 'attendance_report'
  | 'document_report';

export interface CsvExportSpec<Body = unknown, Row = unknown> {
  family: ExportFamily;
  /** A lower-case slug: the file name and the audit row's `report`. */
  report: string;
  /** The rows the JSON body shows. Default: `body.data` (a page) or `body.rows`. */
  rows?: (body: Body) => readonly Row[];
  columns: readonly CsvColumn<Row>[];
}

const CSV_EXPORT = 'asms:csv-export';

/** Query keys that never go into the audit row's filters (paging and the format itself). */
const NOT_FILTERS = new Set(['format', 'page', 'limit']);

function defaultRows(body: unknown): readonly unknown[] {
  if (typeof body === 'object' && body !== null) {
    const record = body as { data?: unknown; rows?: unknown };
    if (Array.isArray(record.data)) return record.data;
    if (Array.isArray(record.rows)) return record.rows;
  }
  throw new Error('a CSV export needs a rows() reader for this body');
}

/** The filters of the request as audited: scalar query values only, paging and format left out. */
function filtersOf(query: Request['query']): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    if (NOT_FILTERS.has(key) || typeof value !== 'string') continue;
    filters[key] = value.slice(0, 64);
  }
  return filters;
}

/**
 * The interceptor behind @CsvExport. A JSON request passes untouched; a CSV request is checked
 * before the handler runs and its body is replaced by the CSV after.
 */
@Injectable()
export class CsvExportInterceptor implements NestInterceptor {
  private readonly sameSite = new SameSitePrintGuard();

  constructor(
    private readonly reflector: Reflector,
    private readonly context: SchoolContext,
    private readonly audit: AuditLogRepository,
    private readonly clock: SchoolClock,
  ) {}

  intercept(execution: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = execution.switchToHttp();
    const req = http.getRequest<Request>();
    if (req.query?.format !== 'csv') return next.handle();
    const spec = this.reflector.get<CsvExportSpec | undefined>(CSV_EXPORT, execution.getHandler());
    if (!spec) throw new Error('format=csv reached a route without @CsvExport');
    // Same-site only, as a print view (a CSV is a download carrying the session cookie).
    this.sameSite.canActivate(execution);
    for (const key of ['page', 'limit']) {
      if (req.query[key] !== undefined) {
        throw fieldRefused(key, ErrorCode.INVALID_VALUE, `${key} is not accepted with format=csv: the export holds every row`);
      }
    }
    const res = http.getResponse<Response>();
    return next.handle().pipe(mergeMap((body: unknown) => from(this.send(spec, req, res, body))));
  }

  private async send(spec: CsvExportSpec, req: Request, res: Response, body: unknown): Promise<string> {
    const rows = (spec.rows ?? defaultRows)(body);
    if (rows.length > CSV_MAX_ROWS) {
      throw fieldRefused(
        'format',
        ErrorCode.INVALID_VALUE,
        `An export holds at most ${CSV_MAX_ROWS.toLocaleString('en-US')} rows: narrow the filters`,
      );
    }
    const text = toCsv(rows, spec.columns);
    const { schoolId, userId } = this.context.actor();
    await this.audit.record(schoolId, {
      actorUserId: userId,
      action: `${spec.family}.exported`,
      subjectType: 'report',
      subjectId: null,
      metadata: { report: spec.report, filters: filtersOf(req.query), rowCount: rows.length },
    });
    const day = (await this.clock.today(schoolId)).toISOString().slice(0, 10);
    res.status(200);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${csvFileName(spec.report, day)}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    return text;
  }
}

/**
 * Opts a report route into `?format=csv` (R336): the columns of the rows the JSON body shows.
 * The route's query DTO declares `format` (@CsvFormatField) and its throttle uses csvCost.
 */
export function CsvExport<Body, Row>(spec: CsvExportSpec<Body, Row>): MethodDecorator {
  return applyDecorators(
    SetMetadata(CSV_EXPORT, spec),
    UseInterceptors(CsvExportInterceptor),
    ApiProduces('application/json', 'text/csv'),
  );
}
