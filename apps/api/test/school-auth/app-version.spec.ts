// R161 (contracts/slice-9.md §1.4) and R170 (§1.3): the app-version floor and the Origin rule as
// Express middleware, driven directly so a floor above 0.0.0 can be tested.
import type { NextFunction, Request, Response } from 'express';
import { ApiException } from '../../src/common/errors/api-exception';
import { appVersionFloor, originCheck, parseAppVersion } from '../../src/common/http';
import { mobileMinAppVersion, type Env } from '../../src/config/env';

function run(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: { method?: string; path?: string; headers?: Record<string, string> },
): ApiException | 'next' {
  let outcome: ApiException | 'next' = 'next';
  const fake = { method: 'GET', path: '/api/v1/me', headers: {}, ...req };
  middleware(
    fake as Request,
    {} as Response,
    ((error?: unknown) => {
      if (error instanceof ApiException) outcome = error;
    }) as NextFunction,
  );
  return outcome;
}

describe('R161: the app-version floor', () => {
  const floor = appVersionFloor('2.3.4');
  const status = (headers: Record<string, string>, path?: string) => {
    const out = run(floor, { headers, ...(path === undefined ? {} : { path }) });
    return out === 'next' ? 'next' : out.status;
  };

  it('R161: compares the three numbers left to right, numerically', () => {
    expect(status({ 'x-app-version': '2.3.4' })).toBe('next');
    expect(status({ 'x-app-version': '2.3.10' })).toBe('next');
    expect(status({ 'x-app-version': '2.10.0' })).toBe('next');
    expect(status({ 'x-app-version': '10.0.0' })).toBe('next');
    expect(status({ 'x-app-version': '2.3.3' })).toBe(426);
    expect(status({ 'x-app-version': '2.2.99' })).toBe(426);
    expect(status({ 'x-app-version': '1.9999.9999' })).toBe(426);
  });

  it('R161: below the floor is 426 UPGRADE_REQUIRED with details.minimumVersion', () => {
    const out = run(floor, { headers: { 'x-app-version': '1.0.0' } });
    expect(out).toBeInstanceOf(ApiException);
    expect(out).toMatchObject({ status: 426, code: 'UPGRADE_REQUIRED', details: { minimumVersion: '2.3.4' } });
  });

  it('R161: a bearer request without the header, or a malformed header, is below every floor', () => {
    expect(status({ authorization: 'Bearer abc' })).toBe(426);
    expect(status({ authorization: 'bearer abc' })).toBe(426);
    for (const bad of ['', '1', '1.2', '1.2.3.4', 'v1.2.3', '12345.0.0', '1.2.x']) {
      expect(status({ 'x-app-version': bad })).toBe(426);
    }
  });

  it('R161: cookie clients, /health and webhooks are exempt', () => {
    expect(status({})).toBe('next');
    expect(status({ cookie: '__Host-asms_session=x' })).toBe('next');
    expect(status({ authorization: 'Basic abc' })).toBe('next');
    expect(status({ authorization: 'Bearer abc' }, '/api/v1/health')).toBe('next');
    expect(status({ 'x-app-version': 'nonsense' }, '/api/v1/webhooks/waha')).toBe('next');
  });

  it('R161: parseAppVersion and the floor default outside production', () => {
    expect(parseAppVersion('0.12.3')).toEqual([0, 12, 3]);
    expect(parseAppVersion(undefined)).toBeNull();
    expect(mobileMinAppVersion({ MOBILE_MIN_APP_VERSION: undefined } as Env)).toBe('0.0.0');
    expect(mobileMinAppVersion({ MOBILE_MIN_APP_VERSION: '3.1.0' } as Env)).toBe('3.1.0');
    expect(() => appVersionFloor('latest')).toThrow();
  });
});

describe('R170: the Origin rule', () => {
  const check = originCheck('http://localhost:3000');
  const status = (req: { method?: string; path?: string; headers?: Record<string, string> }) => {
    const out = run(check, { method: 'POST', ...req });
    return out === 'next' ? 'next' : out.status;
  };

  it('R170: a school non-GET with neither Authorization nor X-App-Version needs the app Origin', () => {
    expect(status({ headers: {} })).toBe(403);
    expect(status({ headers: { cookie: '__Host-asms_session=x' } })).toBe(403);
    expect(status({ headers: { origin: 'https://evil.example' } })).toBe(403);
    expect(status({ headers: { origin: 'http://localhost:3000' } })).toBe('next');
  });

  it('R170: Authorization or X-App-Version exempts a school request (a browser cannot send either cross-origin)', () => {
    expect(status({ headers: { authorization: 'Bearer x' } })).toBe('next');
    expect(status({ headers: { 'x-app-version': '1.0.0' } })).toBe('next');
  });

  it('R170: platform non-GETs always need Origin; GETs and webhooks never', () => {
    expect(status({ path: '/api/v1/platform/schools', headers: { authorization: 'Bearer x', 'x-app-version': '1.0.0' } })).toBe(403);
    expect(status({ method: 'GET', headers: {} })).toBe('next');
    expect(status({ path: '/api/v1/webhooks/waha', headers: {} })).toBe('next');
  });
});
