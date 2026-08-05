/**
 * client.ts — Thin REST client for TCM.
 *
 * The MCP server is a thin client: it does NOT touch Supabase directly.
 * All reads/writes proxy TCM REST endpoints. ID resolution, Zod validation,
 * the generate_test_case_id RPC, in_cicd locking, and soft-delete scoping
 * all happen inside TCM. (PRD §8, OQ-3 option 2.)
 */

import type { AuthProvider } from './auth.js';
import crypto from 'crypto';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** MCP correlation ID for dry-run ↔ commit tracking (Appendix C). */
  correlationId?: string;
  /** MCP intent tag (e.g. 'dry-run-create', 'commit-update'). */
  intent?: string;
}

export class TcmClient {
  private readonly baseUrl: string;

  constructor(private readonly auth: AuthProvider) {
    this.baseUrl = auth.baseUrl;
  }

  /**
   * Make a request to TCM REST API.
   *
   * Auth headers come from the AuthProvider per call (so a refreshing token is always
   * current). On a 401 the provider is given a chance to refresh the credential
   * (handleUnauthorized); if it does, the request is retried exactly once.
   *
   * Never throws: a network-level failure (DNS, connection refused, TLS, timeout) is
   * returned as { ok: false, status: 0 } so callers surface a structured tool error
   * instead of a raw MCP -32603. Redirects are NOT followed — TCM's auth middleware
   * 307-redirects unauthenticated requests to /login; following it would yield a 200
   * HTML page and mask the real failure, so the 3xx is surfaced as a non-ok status.
   */
  async request<T = unknown>(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ ok: boolean; status: number; data: T }> {
    let res = await this.sendOnce(path, options);
    if (res && res.status === 401 && (await this.auth.handleUnauthorized())) {
      res = await this.sendOnce(path, options);
    }

    if (!res) {
      // Network-level failure — surface as a non-ok result rather than throwing.
      return { ok: false, status: 0, data: null as unknown as T };
    }

    let data: T;
    try {
      data = (await res.json()) as T;
    } catch {
      data = null as unknown as T;
    }

    return { ok: res.ok, status: res.status, data };
  }

  /** Single fetch attempt. Returns null on a network-level failure. */
  private async sendOnce(
    path: string,
    options: RequestOptions,
  ): Promise<Response | null> {
    const { method = 'GET', body, correlationId, intent } = options;

    const headers: Record<string, string> = { ...(await this.auth.headers()) };
    if (correlationId) headers['X-MCP-Correlation-Id'] = correlationId;
    if (intent) headers['X-MCP-Intent'] = intent;

    try {
      return await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
    } catch {
      return null;
    }
  }

  /** GET convenience */
  async get<T>(
    path: string,
    opts?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    return this.request<T>(path, { ...opts, method: 'GET' });
  }

  /** POST convenience */
  async post<T>(
    path: string,
    body: unknown,
    opts?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    return this.request<T>(path, { ...opts, method: 'POST', body });
  }

  /** PATCH convenience */
  async patch<T>(
    path: string,
    body: unknown,
    opts?: Omit<RequestOptions, 'method' | 'body'>,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    return this.request<T>(path, { ...opts, method: 'PATCH', body });
  }
}

/**
 * Compute a SHA-256 hash of a normalized write payload for audit correlation.
 * Used to verify a commit payload matches its approved dry-run (Appendix C).
 */
export function hashPayload(payload: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload, Object.keys(payload as object).sort()))
    .digest('hex');
}
