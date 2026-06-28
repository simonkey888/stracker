/**
 * INFRA_01 (stracker_v5.3_integration): Session Persistence — Anti-Cookie Wall.
 *
 * Migrates token management from `document.cookie` (blocked by cross-site
 * tracking restrictions in production/iframe contexts) to a dual storage
 * strategy:
 *   - localStorage   → long-term persistence (survives F5 / browser restart)
 *   - sessionStorage  → transient per-tab state
 *
 * The token travels in the `Authorization: Bearer <token>` header of every
 * API request (see api-client.ts), eliminating dependence on browser cookie
 * jars — the documented point of failure.
 *
 * Refresh loop: `ensureSession()` validates the token's expiry before each
 * call and slides the expiry forward (7-day rolling window), so an active
 * session never silently expires mid-use.
 */

const STORAGE_KEY = 'stracker_session'
const TRANSIENT_KEY = 'stracker_session_transient'
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7-day rolling expiry

export interface SessionToken {
  token: string
  createdAt: number
  exp: number
}

function generateToken(): string {
  // Cryptographically random session token. Falls back to Math.random
  // during SSR or in environments without crypto.getRandomValues.
  const arr = new Uint8Array(24)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(arr)
  } else {
    for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Mints a fresh session token with a 7-day expiry. */
export function createSession(): SessionToken {
  const now = Date.now()
  return { token: generateToken(), createdAt: now, exp: now + TOKEN_TTL_MS }
}

/** Type guard + expiry check. A token is valid iff it has a non-trivial
 *  token string and an unexpired `exp`. */
export function validateToken(session: SessionToken | null): session is SessionToken {
  if (!session) return false
  if (typeof session.token !== 'string' || session.token.length < 16) return false
  if (typeof session.exp !== 'number') return false
  return session.exp > Date.now()
}

/** Reads the session: localStorage (long-term) takes priority over
 *  sessionStorage (transient). Returns null if absent/corrupt. */
export function getSession(): SessionToken | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(TRANSIENT_KEY)
    if (!raw) return null
    return JSON.parse(raw) as SessionToken
  } catch {
    return null
  }
}

/** Persists the session. `persistent=true` (default) writes localStorage so
 *  the session survives F5; `false` writes sessionStorage only. */
export function saveSession(session: SessionToken, persistent = true): void {
  if (typeof window === 'undefined') return
  const raw = JSON.stringify(session)
  try {
    if (persistent) {
      localStorage.setItem(STORAGE_KEY, raw)
      sessionStorage.removeItem(TRANSIENT_KEY)
    } else {
      sessionStorage.setItem(TRANSIENT_KEY, raw)
    }
  } catch {
    /* quota exceeded / private mode — best-effort */
  }
}

/** Clears the session from both stores (logout). */
export function clearSession(): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(STORAGE_KEY)
    sessionStorage.removeItem(TRANSIENT_KEY)
  } catch {
    /* noop */
  }
}

/** Slides the expiry forward by TOKEN_TTL_MS from now (rolling window). */
export function refreshToken(session: SessionToken): SessionToken {
  return { ...session, exp: Date.now() + TOKEN_TTL_MS }
}

/** True iff a valid (non-expired) session exists in storage. */
export function isAuthenticated(): boolean {
  return validateToken(getSession())
}

/** Idempotent session bootstrap. Validates the existing token (refresh loop:
 *  slides expiry forward), or mints + persists a new one if absent/expired.
 *  Call on app mount to guarantee the user "stays logged in" across F5. */
export function ensureSession(persistent = true): SessionToken {
  const existing = getSession()
  if (validateToken(existing)) {
    const refreshed = refreshToken(existing)
    saveSession(refreshed, persistent)
    return refreshed
  }
  const fresh = createSession()
  saveSession(fresh, persistent)
  return fresh
}

/** Returns the raw bearer string for header injection, minting a session
 *  on demand if none exists. */
export function getBearerToken(): string {
  return ensureSession().token
}
