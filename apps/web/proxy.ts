import { NextResponse, type NextRequest } from 'next/server';

/**
 * Sets a nonce-based Content-Security-Policy on every page response.
 *
 * Why a nonce and not a static header in next.config: the App Router streams its RSC payload as
 * inline <script> tags, so a static policy would need script-src 'unsafe-inline', which removes
 * most of the XSS protection a CSP exists for. With a nonce in the request's CSP header, Next
 * stamps it on its own framework, bundle and inline scripts (Next 16 docs, "How nonces work").
 * The cost is that pages must render per request; the root layout calls connection() for that.
 * School data is never server-rendered anyway (phase-1 plan §1), so nothing is lost.
 *
 * Relaxations, each deliberate:
 * - development only: script-src 'unsafe-eval' (React rebuilds server error stacks with eval;
 *   not needed in production per the Next docs).
 * - style-src 'unsafe-inline': Sonner and Base UI inject <style> tags and style attributes at
 *   runtime without a nonce. Style injection is far lower risk than script injection; revisit if
 *   those libraries gain nonce support.
 * - upgrade-insecure-requests: production only, so http://localhost dev and tests still load.
 *
 * This is a header convenience only. It is never an authorisation gate (plan §1).
 */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isDev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // Pages only: not the API (JSON, proxied), static assets, or prefetches. `api(?:/|$)` and
      // not a bare `api`, so a page such as /apiary still gets its CSP.
      source: '/((?!api(?:/|$)|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
