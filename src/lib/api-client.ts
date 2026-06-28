/**
 * INFRA_01 (stracker_v5.3_integration): Authenticated API client.
 *
 * Wraps `fetch` with an AuthMiddleware that:
 *   1. Validates + refreshes the session token before EVERY call (refresh
 *      loop, see auth.ts). This is the "validate el token antes de cada
 *      llamada al API" requirement.
 *   2. Injects `Authorization: Bearer <token>` into every outgoing request,
 *      so authentication no longer depends on the browser cookie jar
 *      (the point of failure under cross-site tracking restrictions).
 *   3. On HTTP 401, clears the stale token and retries exactly once with a
 *      freshly minted one (single retry → no infinite loops).
 *
 * Usage:
 *   import { fetchWithAuth } from '@/lib/api-client'
 *   const resp = await fetchWithAuth('/points?start=...&end=...')
 */

import { ensureSession, clearSession, getBearerToken } from './auth'

export interface FetchWithAuthOptions extends RequestInit {
  /** Skip auth header injection (public endpoints). */
  skipAuth?: boolean
}

function withAuthHeader(options: FetchWithAuthOptions): FetchWithAuthOptions {
  if (options.skipAuth) return options
  const token = getBearerToken()
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return { ...options, headers }
}

/** Authenticated fetch. Validates the token, injects the Bearer header,
 *  and retries once on 401 with a fresh token. */
export async function fetchWithAuth(
  url: string,
  options: FetchWithAuthOptions = {},
): Promise<Response> {
  // Refresh loop: validate/refresh (or mint) the token before each call.
  ensureSession()

  const init = withAuthHeader(options)
  const resp = await fetch(url, init)

  // 401 → token rejected. Clear + mint fresh + retry once.
  if (resp.status === 401 && !options.skipAuth) {
    clearSession()
    const retryInit = withAuthHeader(options)
    return fetch(url, retryInit)
  }

  return resp
}

/** Convenience GET that parses JSON. Throws on non-2xx. */
export async function apiGet<T = unknown>(
  url: string,
  options?: FetchWithAuthOptions,
): Promise<T> {
  const resp = await fetchWithAuth(url, { ...options, method: 'GET' })
  if (!resp.ok) throw new Error(`apiGet ${url} → HTTP ${resp.status}`)
  return resp.json() as Promise<T>
}

/** Convenience POST that JSON-encodes the body. Throws on non-2xx. */
export async function apiPost<T = unknown>(
  url: string,
  body: unknown,
  options?: FetchWithAuthOptions,
): Promise<T> {
  const headers = new Headers(options?.headers)
  headers.set('Content-Type', 'application/json')
  const resp = await fetchWithAuth(url, {
    ...options,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  if (!resp.ok) throw new Error(`apiPost ${url} → HTTP ${resp.status}`)
  return resp.json() as Promise<T>
}
