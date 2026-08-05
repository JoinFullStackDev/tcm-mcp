/**
 * client.ts — Thin REST client for TCM.
 *
 * The MCP server is a thin client: it does NOT touch Supabase directly.
 * All reads/writes proxy TCM REST endpoints. ID resolution, Zod validation,
 * the generate_test_case_id RPC, in_cicd locking, and soft-delete scoping
 * all happen inside TCM. (PRD §8, OQ-3 option 2.)
 */

import type { AuthConfig } from './auth.js';
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
  private readonly defaultHeaders: Record<string, string>;

  constructor(private readonly auth: AuthConfig) {
    this.baseUrl = auth.baseUrl;
    this.defaultHeaders = { ...auth.headers };
  }

  /**
   * Make a request to TCM REST API.
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
    const { method = 'GET', body, correlationId, intent } = options;

    const headers: Record<string, string> = { ...this.defaultHeaders };
    if (correlationId) headers['X-MCP-Correlation-Id'] = correlationId;
    if (intent) headers['X-MCP-Intent'] = intent;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
    } catch {
      // Network-level failure — surface as a non-ok result rather than throwing.
      return { ok: false, status: 0, data: null as unknown as T };
    }

    let data: T;
    try {
      data = await res.json() as T;
    } catch {
      data = null as unknown as T;
    }

    return { ok: res.ok, status: res.status, data };
  }

  /** GET convenience */
  async get<T>(path: string, opts?: Omit<RequestOptions, 'method' | 'body'>): Promise<{ ok: boolean; status: number; data: T }> {
    return this.request<T>(path, { ...opts, method: 'GET' });
  }

  /** POST convenience */
  async post<T>(path: string, body: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>): Promise<{ ok: boolean; status: number; data: T }> {
    return this.request<T>(path, { ...opts, method: 'POST', body });
  }

  /** PATCH convenience */
  async patch<T>(path: string, body: unknown, opts?: Omit<RequestOptions, 'method' | 'body'>): Promise<{ ok: boolean; status: number; data: T }> {
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
