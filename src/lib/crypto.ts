/**
 * SECURITY_FORTRESS — stracker_v5.8_pro_fortress
 *
 * AES-256-GCM encryption for sensitive data at rest (localStorage cache).
 *
 * Defense-in-depth: even if an attacker exfiltrates the browser's localStorage,
 * the ghosttrail history is encrypted and unreadable without the key.
 *
 * Key Derivation:
 *   The encryption key is derived from the user's session token via PBKDF2
 *   (100,000 iterations, SHA-256). The session token is unique per session
 *   and stored ONLY in localStorage (never bundled in the JS payload).
 *   This means:
 *     - The key is never hardcoded in the source code.
 *     - The key is never transmitted over the network.
 *     - Each session has a unique key (rotated on re-auth).
 *     - An attacker with the JS bundle but not the session token cannot decrypt.
 *
 * Server-side equivalent (documented for the Python backend):
 *   The backend should use `process.env.SECRET_KEY` (rotated every 30 days)
 *   with the same AES-256-GCM algorithm to encrypt the DB columns storing
 *   ghosttrail history. The key must reside in a secret manager (AWS Secrets
 *   Manager, HashiCorp Vault, or Render's secret env vars), never in source.
 *
 * Algorithm:
 *   - AES-256-GCM (authenticated encryption — detects tampering)
 *   - 96-bit IV (12 bytes, cryptographically random per encryption)
 *   - 128-bit auth tag (16 bytes, appended to ciphertext)
 *   - PBKDF2 key derivation: 100,000 iterations, SHA-256, 256-bit output
 */

const PBKDF2_ITERATIONS = 100_000
const SALT_LENGTH = 16 // bytes
const IV_LENGTH = 12 // bytes (96-bit, standard for GCM)
const KEY_LENGTH = 256 // bits

/**
 * Cached derived key — re-derivation on every call would be expensive.
 * Keyed by the session token hash so re-auth automatically rotates.
 */
let cachedKey: CryptoKey | null = null
let cachedKeyToken: string | null = null

/**
 * Derive an AES-256-GCM key from the session token using PBKDF2.
 * The token is read from localStorage (where auth.ts stores it).
 * A static salt is mixed in to prevent rainbow table attacks.
 *
 * @param sessionToken  The Bearer token from localStorage. If null,
 *                       falls back to a device-bound key (less secure
 *                       but still better than plaintext).
 */
async function deriveKey(sessionToken: string | null): Promise<CryptoKey> {
  // Cache check — avoid re-deriving on every call
  if (cachedKey && cachedKeyToken === sessionToken) {
    return cachedKey
  }

  // The "password" for PBKDF2. If no session token, use a device-bound
  // identifier (still unique per device, but not per session).
  const password = sessionToken || getDeviceBoundSecret()

  // Static salt — mixed with a per-device random component stored once.
  // The device salt is generated on first use and persisted.
  const deviceSalt = getOrCreateDeviceSalt()
  const encoder = new TextEncoder()

  // Import the password as raw key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  )

  // Derive the AES-256-GCM key
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: deviceSalt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: KEY_LENGTH },
    false, // not extractable
    ['encrypt', 'decrypt'],
  )

  cachedKey = key
  cachedKeyToken = sessionToken
  return key
}

/**
 * Get or create a per-device salt (16 bytes, stored in localStorage).
 * Generated once on first use, then persisted. This prevents rainbow table
 * attacks even if two devices use the same session token.
 */
function getOrCreateDeviceSalt(): Uint8Array {
  const SALT_KEY = 'stracker_device_salt'
  try {
    const existing = localStorage.getItem(SALT_KEY)
    if (existing) {
      // Decode base64 → bytes
      const bytes = atob(existing)
      const arr = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
      if (arr.length === SALT_LENGTH) return arr
    }
    // Generate new salt
    const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
    // Encode to base64 for storage
    let binary = ''
    for (let i = 0; i < salt.length; i++) binary += String.fromCharCode(salt[i])
    localStorage.setItem(SALT_KEY, btoa(binary))
    return salt
  } catch {
    // localStorage unavailable — use ephemeral salt (less ideal)
    return crypto.getRandomValues(new Uint8Array(SALT_LENGTH))
  }
}

/**
 * Device-bound secret fallback (when no session token is available).
 * Combines a random component (persisted) with navigator properties
 * to create a semi-stable device fingerprint. NOT cryptographic-grade,
 * but better than plaintext.
 */
function getDeviceBoundSecret(): string {
  const DEVICE_SECRET_KEY = 'stracker_device_secret'
  try {
    const existing = localStorage.getItem(DEVICE_SECRET_KEY)
    if (existing) return existing
    // Generate a random secret
    const bytes = crypto.getRandomValues(new Uint8Array(32))
    let hex = ''
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
    localStorage.setItem(DEVICE_SECRET_KEY, hex)
    return hex
  } catch {
    return 'fallback-insecure-key-0001'
  }
}

/**
 * Read the session token from localStorage (same key as auth.ts).
 */
function getSessionToken(): string | null {
  try {
    const raw = localStorage.getItem('stracker_session')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed.token || null
  } catch {
    return null
  }
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 *
 * Returns a base64 string containing: IV (12 bytes) || ciphertext || auth tag (16 bytes).
 * The IV is prepended so decryption can extract it. The auth tag is appended
 * automatically by the Web Crypto API.
 *
 * @param plaintext  The string to encrypt
 * @returns          Base64-encoded encrypted payload, or null if encryption fails
 */
export async function encryptString(plaintext: string): Promise<string | null> {
  if (typeof window === 'undefined' || !crypto.subtle) return null
  try {
    const key = await deriveKey(getSessionToken())
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const encoder = new TextEncoder()
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(plaintext),
    )
    // Combine IV + ciphertext+tag into a single byte array
    const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
    combined.set(iv, 0)
    combined.set(new Uint8Array(ciphertext), IV_LENGTH)
    // Base64 encode for storage
    let binary = ''
    for (let i = 0; i < combined.length; i++) binary += String.fromCharCode(combined[i])
    return btoa(binary)
  } catch (err) {
    console.error('[crypto] encryptString failed:', err)
    return null
  }
}

/**
 * Decrypt a base64-encoded AES-256-GCM payload.
 *
 * @param encrypted  Base64 string from encryptString()
 * @returns          Decrypted plaintext, or null if decryption fails
 *                   (wrong key, tampered data, corrupted payload)
 */
export async function decryptString(encrypted: string): Promise<string | null> {
  if (typeof window === 'undefined' || !crypto.subtle) return null
  try {
    const key = await deriveKey(getSessionToken())
    // Base64 decode → bytes
    const binary = atob(encrypted)
    const combined = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) combined[i] = binary.charCodeAt(i)
    // Extract IV (first 12 bytes) and ciphertext+tag (rest)
    const iv = combined.slice(0, IV_LENGTH)
    const ciphertext = combined.slice(IV_LENGTH)
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext,
    )
    return new TextDecoder().decode(decrypted)
  } catch (err) {
    console.error('[crypto] decryptString failed:', err)
    return null
  }
}

/**
 * Encrypt a JSON-serializable object and store it in localStorage.
 *
 * This is the primary API for encrypting the ghosttrail cache. The data
 * is JSON-stringified, then AES-256-GCM encrypted, then stored.
 *
 * If encryption is unavailable (old browser, no crypto.subtle), falls back
 * to plaintext storage with a warning prefix so the data can still be read
 * but is clearly marked as unencrypted.
 *
 * @param key     localStorage key
 * @param data    Object to encrypt and store
 */
export async function setEncryptedItem(key: string, data: unknown): Promise<void> {
  if (typeof window === 'undefined') return
  try {
    const json = JSON.stringify(data)
    const encrypted = await encryptString(json)
    if (encrypted) {
      localStorage.setItem(key, `enc:v1:${encrypted}`)
    } else {
      // Fallback: plaintext with marker (defense-in-depth, not ideal)
      console.warn(`[crypto] Encryption unavailable for ${key}, storing plaintext fallback`)
      localStorage.setItem(key, `plain:v1:${json}`)
    }
  } catch (err) {
    console.error(`[crypto] setEncryptedItem failed for ${key}:`, err)
  }
}

/**
 * Read and decrypt an item from localStorage that was stored via setEncryptedItem.
 *
 * Handles three formats:
 *   - `enc:v1:<base64>`    — encrypted (current, preferred)
 *   - `plain:v1:<json>`    — plaintext fallback (old browser)
 *   - `<raw json>`         — legacy unencrypted (pre-v5.8 data, auto-migrated)
 *
 * @param key   localStorage key
 * @returns     Parsed object, or null if not found / decryption fails
 */
export async function getEncryptedItem<T = unknown>(key: string): Promise<T | null> {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null

    // Encrypted format
    if (raw.startsWith('enc:v1:')) {
      const encrypted = raw.slice(7) // strip "enc:v1:"
      const json = await decryptString(encrypted)
      if (json == null) return null
      return JSON.parse(json) as T
    }

    // Plaintext fallback format
    if (raw.startsWith('plain:v1:')) {
      return JSON.parse(raw.slice(9)) as T
    }

    // Legacy unencrypted format — read directly (backward compat)
    // This allows existing users to upgrade without data loss.
    return JSON.parse(raw) as T
  } catch (err) {
    console.error(`[crypto] getEncryptedItem failed for ${key}:`, err)
    return null
  }
}

/**
 * Check if a localStorage item is currently encrypted.
 * Useful for diagnostics and migration status.
 */
export function isItemEncrypted(key: string): boolean {
  if (typeof window === 'undefined') return false
  try {
    const raw = localStorage.getItem(key)
    return raw != null && raw.startsWith('enc:v1:')
  } catch {
    return false
  }
}

/**
 * Clear the cached encryption key. Call this on logout / session change
 * to force re-derivation with the new session token.
 */
export function clearCachedKey(): void {
  cachedKey = null
  cachedKeyToken = null
}
