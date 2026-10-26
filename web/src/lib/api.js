/* API client: JSON in/out, CSRF token on every write, one error type with the server's code. */

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.code = data?.code || null;
    this.data = data || {};
  }
}

export const api = {
  csrf: null,
  liveMode: 'sse',
  pollMs: 2500,
  onUnauthenticated: null,
  extraHeaders: {},
  async request(method, url, body) {
    const headers = { Accept: 'application/json', ...this.extraHeaders };
    if (body !== undefined) headers['Content-Type'] = typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json';
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    let res;
    try {
      res = await fetch(url, {
        method, headers, credentials: 'same-origin', cache: 'no-store',
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, { error: 'Network error. Check your connection and try again.', code: 'NETWORK' });
    }
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      if (res.status === 401 && this.onUnauthenticated) this.onUnauthenticated();
      throw new ApiError(res.status, data);
    }
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body = {}) { return this.request('POST', url, body); },
  put(url, body = {}) { return this.request('PUT', url, body); },
  del(url) { return this.request('DELETE', url); },
};

/** Query string from an object, skipping empty values. */
export const qs = (o) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};
