'use client';

import { tableFeatures, useTable, type ColumnDef } from '@tanstack/react-table';
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState, ErrorState, NoPermissionState, isPermissionDenied } from './page-states';

/**
 * The one table component (plan §3.10). Pagination, sorting and filtering happen on the server:
 * the table renders exactly the page it is given and reports page changes upward.
 * Build columns with `createColumnHelper<DataTableFeatures, Row>()`.
 */
export const dataTableFeatures = tableFeatures({});
export type DataTableFeatures = typeof dataTableFeatures;

type DataTableProps<TData extends object> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- columns hold mixed value types
  columns: ColumnDef<DataTableFeatures, TData, any>[];
  /** Rows of the current page. Pass a stable reference (query data or a module constant). */
  data: TData[];
  getRowId?: (row: TData) => string;
  /** Server pagination, as the API returns it: `{ data, page, limit, total }`. */
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
};

export function DataTable<TData extends object>({
  columns,
  data,
  getRowId,
  page,
  limit,
  total,
  onPageChange,
  isLoading = false,
  error,
  onRetry,
  emptyTitle,
  emptyDescription,
  emptyAction,
}: DataTableProps<TData>) {
  const table = useTable({ features: dataTableFeatures, columns, data, getRowId });

  if (error) {
    return (
      <Frame>
        {isPermissionDenied(error) ? (
          <NoPermissionState />
        ) : (
          <ErrorState error={error} onRetry={onRetry} />
        )}
      </Frame>
    );
  }

  const rows = table.getRowModel().rows;

  if (!isLoading && rows.length === 0) {
    return (
      <Frame>
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      </Frame>
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / limit));
  const first = total === 0 ? 0 : (page - 1) * limit + 1;
  const last = Math.min(page * limit, total);

  return (
    <Frame>
      <Table aria-busy={isLoading}>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => (
                <TableHead key={header.id} className="px-4 text-muted-foreground">
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {isLoading
            ? Array.from({ length: Math.min(limit, 8) }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  {columns.map((_, j) => (
                    <TableCell key={j} className="px-4">
                      <Skeleton className="h-4 w-full max-w-40" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="px-4">
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
        </TableBody>
      </Table>
      <div className="flex items-center justify-between gap-4 border-t px-4 py-3 text-sm text-muted-foreground">
        <span aria-live="polite">
          {isLoading ? 'Loading…' : `Showing ${first}–${last} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <span className="hidden sm:inline">
            Page {page} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Previous page"
            disabled={isLoading || page <= 1}
            onClick={() => onPageChange(page - 1)}
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Next page"
            disabled={isLoading || page >= pageCount}
            onClick={() => onPageChange(page + 1)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </Frame>
  );
}

/**
 * A sortable column header for server-side sort. The API's sort value is the field name for
 * ascending and `-field` for descending; clicking toggles, starting ascending.
 * Use it as a column `header`: `header: () => <SortHeader field="name" label="Name" ... />`.
 */
export function SortHeader<F extends string>({
  field,
  label,
  sort,
  onSort,
}: {
  field: F;
  label: string;
  sort: F | `-${F}`;
  onSort: (sort: F | `-${F}`) => void;
}) {
  const direction = sort === field ? 'ascending' : sort === `-${field}` ? 'descending' : null;
  const Icon =
    direction === 'ascending'
      ? ArrowUpIcon
      : direction === 'descending'
        ? ArrowDownIcon
        : ArrowUpDownIcon;
  return (
    <button
      type="button"
      className="-mx-1 inline-flex items-center gap-1 rounded px-1 font-medium hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      onClick={() => onSort(direction === 'ascending' ? `-${field}` : field)}
    >
      {label}
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{direction ? `, sorted ${direction}` : ', not sorted'}</span>
    </button>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="overflow-hidden rounded-lg border bg-card">{children}</div>;
}
