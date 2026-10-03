// L3: a provider answering with a redirect must not have the request (API key, bearer token,
// message body) re-sent to wherever the redirect points.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { providerFetch, transportError } from './http';

describe('providerFetch', () => {
  let server: Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      if (req.url === '/redirect') {
        res.writeHead(302, { Location: '/elsewhere' }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('answers an ordinary response', async () => {
    expect((await providerFetch(`${base}/ok`)).status).toBe(200);
  });

  it('refuses a redirect instead of following it, mapped as provider_unavailable', async () => {
    hits.length = 0;
    let thrown: unknown;
    try {
      await providerFetch(`${base}/redirect`, { method: 'POST', body: 'secret-body' });
    } catch (error) {
      thrown = error;
    }
    // fetch rejects with a TypeError from Node's own realm, so no instanceof check here.
    expect(thrown).toMatchObject({ name: 'TypeError' });
    expect(transportError(thrown)).toBe('provider_unavailable');
    expect(hits).toEqual(['/redirect']);
  });
});
