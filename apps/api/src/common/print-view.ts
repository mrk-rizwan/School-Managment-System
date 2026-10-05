// Print views (phase-3-financial.md §3.5, R237): receipts and payslips are HTML pages the browser
// prints, sent only through sendPrintView. The page is built with the `html` tag, which escapes
// every interpolated value, so a fee-head name holding `<script>` prints as text; the template
// text itself may not carry a script, and the CSP refuses one anyway.

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text as HTML text: the five significant characters escaped. */
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const SAFE = Symbol('SafeHtml');

/** HTML produced by `html` (or `printPage`); nothing else can reach sendPrintView. */
export interface SafeHtml {
  readonly [SAFE]: true;
  readonly value: string;
}

const safe = (value: string): SafeHtml => ({ [SAFE]: true, value });

const isSafe = (value: unknown): value is SafeHtml =>
  typeof value === 'object' && value !== null && SAFE in value;

/** What may be interpolated: text and numbers are escaped; SafeHtml (or a list of it) is kept. */
export type HtmlValue = string | number | SafeHtml | readonly SafeHtml[] | null | undefined;

const SCRIPT = /<\s*script|\son[a-z]+\s*=|javascript:/i;

/**
 * The auto-escaping template tag. `null` and `undefined` render as nothing. The literal parts are
 * the code's own markup and may not hold a script tag, an inline handler or a javascript: URL.
 *
 * Callers quote every attribute value (`class="${x}"`, never `class=${x}`: an unquoted value ends
 * at a space the escaping leaves alone), and never interpolate a URL into href, src or any other
 * attribute: escaping makes text safe, not a URL. A print view links to nothing.
 */
export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): SafeHtml {
  let out = '';
  strings.forEach((part, i) => {
    if (SCRIPT.test(part)) throw new Error('a print view never carries a script');
    out += part;
    if (i >= values.length) return;
    const value = values[i];
    if (value === null || value === undefined) return;
    if (typeof value === 'string') out += escapeHtml(value);
    else if (typeof value === 'number') out += escapeHtml(String(value));
    else if (isSafe(value)) out += value.value;
    else out += value.map((v: SafeHtml) => v.value).join('');
  });
  return safe(out);
}

/** A whole printable document: doctype, title, plain print styles, the body. */
export const printPage = (title: string, body: SafeHtml): SafeHtml =>
  html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: system-ui, sans-serif; color: #111; margin: 24px; font-size: 14px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #ddd; }
  td.amount, th.amount { text-align: right; font-variant-numeric: tabular-nums; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
${body}
</body>
</html>`;

/** The headers every print view carries (R237). */
export const PRINT_VIEW_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Disposition': 'inline',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
};

/** What sendPrintView writes to: an Express Response satisfies it. */
export interface PrintTarget {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  send(body: string): unknown;
}

/** Sends a print view: 200, the headers above, the escaped page. The only way one is sent. */
export function sendPrintView(res: PrintTarget, page: SafeHtml): void {
  res.status(200);
  for (const [name, value] of Object.entries(PRINT_VIEW_HEADERS)) res.setHeader(name, value);
  res.send(page.value);
}
