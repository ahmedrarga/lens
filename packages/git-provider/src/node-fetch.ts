import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';

/**
 * Minimal GET-only fetch on node:http(s). Node's global fetch always sends `sec-fetch-mode: cors`,
 * which gitlab.com treats as a browser request and answers archive downloads with 406.
 */
export function nodeFetch(input: string | URL | Request, init: RequestInit = {}, redirects = 5): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'http:' ? httpRequest : httpsRequest)(url, { method: 'GET', headers }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location && redirects > 0) {
        res.resume();
        const next = new URL(location, url);
        // Don't forward credentials to another host.
        const nextHeaders = next.host === url.host ? init.headers : undefined;
        resolve(nodeFetch(next, { ...init, headers: nextHeaders }, redirects - 1));
        return;
      }
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const body = status === 204 || status === 304 ? null : (Readable.toWeb(res) as ReadableStream);
      resolve(new Response(body, { status, statusText: res.statusMessage, headers: h }));
    });
    req.on('error', reject);
    init.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')));
    req.end();
  });
}
