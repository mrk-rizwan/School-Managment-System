import type { NextConfig } from 'next';

// The browser talks to the API on this origin only: /api/* is proxied to the Nest process on
// loopback, so the session cookie is first-party and no CORS configuration exists anywhere.
const apiPort = process.env.API_PORT || '3001';

// Static security headers for every response. The Content-Security-Policy is not here: it
// carries a per-request nonce, so it is set in proxy.ts (see the comment there).
const securityHeaders = [
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,

  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },

  async redirects() {
    return [{ source: '/', destination: '/login', permanent: false }];
  },

  async rewrites() {
    return {
      // beforeFiles: /api/* never reaches an app route, whatever is added under app/ later.
      beforeFiles: [
        { source: '/api/:path*', destination: `http://127.0.0.1:${apiPort}/api/:path*` },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
