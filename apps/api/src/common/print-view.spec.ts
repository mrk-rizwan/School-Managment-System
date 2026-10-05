// R237 (phase-3-financial.md §3.5): print views escape every value, carry no script and send the
// fixed headers. Receipts (slice 20) and payslips (slice 25) are built on this.
import { html, printPage, PRINT_VIEW_HEADERS, sendPrintView } from './print-view';

describe('print views (R237)', () => {
  it('a <script> fee-head name prints as text', () => {
    const name = '<script>alert("x")</script> & \'Tuition\'';
    const page = printPage('Receipt 17/2026-27', html`<p>${name}</p><p>${12500}</p>`);
    expect(page.value).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;Tuition&#39;');
    expect(page.value).not.toMatch(/<script/i);
    expect(page.value).toContain('<title>Receipt 17/2026-27</title>');
  });

  it('nested safe fragments are kept; null and undefined render as nothing', () => {
    const rows = ['a', 'b'].map((x) => html`<tr><td>${x}</td></tr>`);
    expect(html`<table>${rows}${null}${undefined}</table>`.value).toBe(
      '<table><tr><td>a</td></tr><tr><td>b</td></tr></table>',
    );
  });

  it('the template text itself may not carry a script, a handler or a javascript: URL', () => {
    expect(() => html`<script>x</script>`).toThrow('never carries a script');
    expect(() => html`<img src="a" onerror="x">`).toThrow('never carries a script');
    expect(() => html`<a href="javascript:x">`).toThrow('never carries a script');
  });

  it('sendPrintView sends 200 with text/html inline, default-src none, nosniff and no-store', () => {
    const headers: Record<string, string> = {};
    let status = 0;
    let body = '';
    const res = {
      status: (s: number) => {
        status = s;
      },
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      send: (b: string) => {
        body = b;
      },
    };
    sendPrintView(res, html`<p>${'<b>'}</p>`);
    expect(status).toBe(200);
    expect(headers).toEqual(PRINT_VIEW_HEADERS);
    expect(headers['Content-Security-Policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(body).toBe('<p>&lt;b&gt;</p>');
  });
});
