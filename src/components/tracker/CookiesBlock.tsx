'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { Key, Cookie, TriangleAlert, CircleCheck, CircleX, Clock, Hourglass, Download, Sparkles, ChevronDown, Copy } from 'lucide-react'

/**
 * CookiesBlock — T4 (Gemini roast): MANUAL_PAINLESS.
 *
 * Decision: Playwright/CDP auto-refresh NOT viable on Render free tier
 * (no persistent Chrome, 512MB RAM, sleeps). Keep manual import BUT
 * eliminate ALL friction:
 *
 *   Step 1 — Auto-detect on window focus: when Simon returns to the app
 *            after copying cookies from DevTools/extension, we read the
 *            clipboard via navigator.clipboard.readText() automatically.
 *
 *   Step 2 — Predictive parser: if the clipboard contains a recognized
 *            cookie pattern (JSON array with "__Secure-1PSIDTS", or a
 *            "Cookie:" header string, or Netscape format), we auto-POST
 *            to /api/cookies with format:'auto'. Zero clicks.
 *
 *   Step 3 — TTL countdown bar: linear progress green→red estimating
 *            session expiration based on min_expiration from backend.
 *            Warns BEFORE the session dies, not after.
 *
 * UI: collapsible (collapsed 34px row [Key icon, count, status, chevron];
 * expanded: textarea + IMPORTAR). FIX_1 (stracker_hotfix_ui_v8.1): the
 * Key button NO LONGER opens a new tab — it toggles an internal session
 * panel (SPA-immersive). An explicit "Abrir Google Maps" secondary action
 * lives inside the panel for the rare case it's needed.
 * FIX_3: all emojis replaced with lucide-react vector icons; containers
 * use intense glassmorphism (bg-zinc-950/60 backdrop-blur-2xl border-white/5).
 */
interface CookiesBlockProps {
  showToast: (msg: string) => void
  /** Called whenever the block expands or collapses — TrackerView uses this to invalidate leaflet size. */
  onToggle?: (expanded: boolean) => void
  /** V9: when true (tiny viewport), force collapsed state to save height. */
  forceCollapse?: boolean
}

interface CookieStatus {
  status: string
  count: number
  has_critical: boolean
  missing_critical: string[]
  critical_keys: string[]
  domains: string[]
  min_expiration: number | null
  max_expiration: number | null
  expiring_soon: boolean
  last_updated: number | null
}

interface ImportResult {
  status: string
  message?: string
  error?: string
  count?: number
  domains?: string[]
  missing_critical?: string[]
  has_critical?: boolean
  more_complete?: boolean
  gained?: string[]
  lost?: string[]
  old_count?: number
  min_expiration?: number | null
  max_expiration?: number | null
  critical_keys?: string[]
}

function formatExpiration(ts: number | null | undefined): string {
  if (ts == null || !isFinite(ts)) return '---'
  const d = new Date(ts * 1000)
  const now = new Date()
  const diffMs = d.getTime() - now.getTime()
  const days = Math.floor(diffMs / (24 * 3600 * 1000))
  if (days < 0) return 'EXPIRADA'
  if (days < 1) return '<24h'
  if (days < 7) return `${days}d`
  if (days < 30) return `${Math.floor(days / 7)}sem`
  if (days < 365) return `${Math.floor(days / 30)}mes`
  return `${Math.floor(days / 365)}año`
}

// ── T4 Step 2: Predictive cookie pattern detection ──
// Returns true if the string looks like a Google cookies payload.
function looksLikeCookies(raw: string): boolean {
  if (!raw || raw.length < 30) return false
  // JSON array of cookie objects (Chrome export)
  if (raw.trim().startsWith('[') && raw.includes('__Secure-1PSID')) return true
  if (raw.trim().startsWith('{') && raw.includes('SAPISID')) return true
  // Header string: "Cookie: SID=...; HSID=..."
  if (/^Cookie:\s/im.test(raw) && raw.includes('HSID')) return true
  if (raw.includes('SID=') && raw.includes('__Secure-1PSID=')) return true
  // Netscape format: domain<TAB>flag<TAB>path<TAB>secure<TAB>expiration<TAB>name<TAB>value
  if (/#\s*Netscape/i.test(raw) && raw.includes('.google.com')) return true
  return false
}

export function CookiesBlock({ showToast, onToggle, forceCollapse }: CookiesBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [pasteValue, setPasteValue] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const [status, setStatus] = useState<CookieStatus | null>(null)
  const [loadingStatus, setLoadingStatus] = useState(false)
  const [isMobile, setIsMobile] = useState(false)
  const [isShortViewport, setIsShortViewport] = useState(false)
  // FIX_1 (stracker_hotfix_ui_v8.1): internal session panel replaces the
  // new-tab Google Maps opener so the user never leaves the SPA.
  const [showSessionPanel, setShowSessionPanel] = useState(false)

  // V9: auto-collapse when forceCollapse becomes true (tiny viewport)
  useEffect(() => {
    if (forceCollapse && expanded) {
      setExpanded(false)
      onToggle?.(false)
    }
  }, [forceCollapse, expanded, onToggle])
  // T4 Step 3: live TTL countdown (re-render every minute to update the bar)
  const [, setTick] = useState(0)
  // Guard to avoid re-importing the same clipboard content in a loop
  const lastImportedHashRef = useRef<string>('')

  useEffect(() => {
    const check = () => {
      if (typeof window === 'undefined') return
      const w = window.innerWidth
      const h = window.innerHeight
      setIsMobile(w < 768)
      setIsShortViewport(w < 360 || h < 600)
    }
    check()
    const onResize = () => check()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // T4 Step 3: tick every 60s so the TTL bar stays fresh
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true)
    try {
      const resp = await fetch('/api/cookies/status')
      if (resp.ok) {
        const data: CookieStatus = await resp.json()
        setStatus(data)
      }
    } catch {
      // silent — status is best-effort
    } finally {
      setLoadingStatus(false)
    }
  }, [])

  useEffect(() => {
    fetchStatus()
    // Poll status every 2min so TTL stays fresh
    const id = setInterval(fetchStatus, 120000)
    return () => clearInterval(id)
  }, [fetchStatus])

  // ── T4 Step 1+2: Auto-detect clipboard on window focus ──
  // When Simon returns to the tab (after copying cookies from DevTools/extension),
  // we read the clipboard. If it looks like cookies, auto-POST. Zero clicks.
  const importCookies = useCallback(async (raw: string, silent = false) => {
    if (!raw.trim()) {
      if (!silent) showToast('Pegá las cookies primero')
      return
    }
    setImporting(true)
    setImportResult(null)
    try {
      const resp = await fetch('/api/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: 'auto', data: raw }),
      })
      const data: ImportResult = await resp.json()
      setImportResult(data)
      if (resp.ok && data.status === 'ok') {
        const missing = data.missing_critical || []
        if (data.has_critical) {
          showToast(`${data.count} cookies importadas — sesión completa`)
        } else {
          showToast(`Faltan: ${missing.join(', ')}`)
        }
        setPasteValue('')
        fetchStatus()
        return true
      } else {
        if (!silent) showToast(data.error || 'Error al importar')
        return false
      }
    } catch {
      if (!silent) showToast('Error de conexión al importar')
      return false
    } finally {
      setImporting(false)
    }
  }, [showToast, fetchStatus])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onFocus = async () => {
      if (!navigator.clipboard?.readText) return
      try {
        const text = await navigator.clipboard.readText()
        if (!text || text.length < 30) return
        if (!looksLikeCookies(text)) return
        const hash = text.slice(0, 64) + text.length
        if (hash === lastImportedHashRef.current) return
        lastImportedHashRef.current = hash
        showToast('Cookies detectadas en portapapeles — importando…')
        await importCookies(text, true)
      } catch {
        // clipboard read denied — silent (user must paste manually)
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [importCookies, showToast])

  const toggleExpand = useCallback(() => {
    if (isShortViewport || forceCollapse) {
      showToast('En pantalla pequeña — usá desktop para importar')
      return
    }
    setExpanded((prev) => {
      const next = !prev
      onToggle?.(next)
      return next
    })
  }, [isShortViewport, forceCollapse, showToast, onToggle])

  // FIX_1: primary click toggles an INTERNAL panel (no new tab). The user
  // stays in the SPA. An explicit secondary action inside the panel can
  // open Google Maps if genuinely needed.
  const toggleSessionPanel = useCallback(() => {
    setShowSessionPanel((prev) => !prev)
  }, [])

  // FIX_PREVIEW_04: openGoogleMaps (window.open _blank) removed to keep the
  // user inside the SPA. copyMapsUrl is the single primary action.

  const copyMapsUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText('https://www.google.com/maps')
      showToast('URL de Google Maps copiada')
    } catch {
      showToast('No se pudo copiar la URL')
    }
  }, [showToast])

  // Manual IMPORTAR (from textarea)
  const handleManualImport = useCallback(() => {
    importCookies(pasteValue)
  }, [pasteValue, importCookies])

  // V5.5 Deep Black: status is monochrome. The pill count + label read in
  // white; the TTL bar (below) communicates health via brightness, not hue.
  const criticalOk = status?.has_critical ?? false
  const expiringSoon = status?.expiring_soon ?? false
  const statusColor = 'rgba(255,255,255,.85)'

  // FIX_3: lucide icon instead of emoji
  const StatusIcon = criticalOk
    ? (expiringSoon ? Clock : CircleCheck)
    : TriangleAlert
  const statusLabel = criticalOk
    ? (expiringSoon ? 'Expira pronto' : 'Sesión OK')
    : `Faltan: ${(status?.missing_critical || []).slice(0, 2).join(', ')}${(status?.missing_critical?.length || 0) > 2 ? '…' : ''}`
  // V5.5 Deep Black: TTL bar is monochrome — bright white when fresh,
  // dimming to near-transparent as the session nears expiry. No green→red hue.
  const nowSec = Date.now() / 1000
  const minExp = status?.min_expiration ?? null
  const ttlSec = minExp != null ? Math.max(0, minExp - nowSec) : 0
  const REF_WINDOW_SEC = 7 * 24 * 3600
  const ttlFraction = minExp != null ? Math.max(0, Math.min(1, ttlSec / REF_WINDOW_SEC)) : 0
  const ttlColor = `rgba(255,255,255,${(0.25 + ttlFraction * 0.7).toFixed(2)})`

  // V9: collapsed row height is exactly 34px INCLUDING the TTL bar.
  const rowH = 34
  const iconBtnSize = isMobile ? 30 : 32
  const padY = isMobile ? 3 : 4

  // V5.5 Deep Black: shared glass pill.
  const glassPill = 'bg-[#0a0a0a]/85 backdrop-blur-xl border border-white/[0.05]'

  return (
    <div
      className={isMobile ? 'px-2' : 'px-2.5'}
      style={{
        paddingTop: padY,
        paddingBottom: padY,
        borderTop: '1px solid rgba(255,255,255,0.04)',
        background: 'rgba(255,255,255,.01)',
      }}
    >
      {/* ── V9 COLLAPSED ROW: [Key, count, status, chevron] — 34px including TTL strip ── */}
      <div className="flex items-center gap-1.5 flex-nowrap" style={{ minHeight: rowH - 4 }}>
        {/* FIX_1: Key button toggles an INTERNAL session panel (no new tab) */}
        <button
          onClick={toggleSessionPanel}
          title="Sesión — ver estado e instrucciones"
          aria-label="Sesión — ver estado e instrucciones"
          aria-expanded={showSessionPanel}
          className={`flex items-center justify-center flex-shrink-0 transition-all active:scale-95 rounded-full ${glassPill} hover:bg-white/10`}
          style={{
            width: iconBtnSize,
            height: iconBtnSize,
            color: showSessionPanel ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.7)',
            cursor: 'pointer',
          }}
        >
          <Key size={15} strokeWidth={1.5} />
        </button>

        <div
          className={`flex items-center gap-1 flex-shrink-0 px-2 rounded-full ${glassPill}`}
          style={{
            height: iconBtnSize,
            color: statusColor,
            fontSize: 'clamp(9px, 2vw, 11px)',
            fontWeight: 700,
          }}
          title={`${statusLabel}${status && status.min_expiration != null ? ` · expira ${formatExpiration(status.min_expiration)}` : ''}`}
        >
          <StatusIcon size={11} strokeWidth={1.5} style={{ color: statusColor }} />
          <span className="font-mono tracking-wider">
            {loadingStatus ? '…' : (status ? status.count : '---')}
          </span>
          <Cookie size={10} strokeWidth={1.5} style={{ opacity: 0.7 }} />
        </div>

        <div
          className={`flex items-center gap-1 flex-1 min-w-0 px-2 rounded-full ${glassPill}`}
          style={{
            height: iconBtnSize,
            color: statusColor,
            fontSize: 'clamp(8px, 1.8vw, 10px)',
            fontWeight: 600,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
          title={statusLabel}
        >
          <span className="truncate">{statusLabel}</span>
          {status && status.min_expiration != null && (
            <span className="flex items-center gap-0.5 flex-shrink-0" style={{ fontSize: 9, opacity: 0.75 }}>
              <Hourglass size={9} strokeWidth={1.5} />
              <span className="tabular-nums">{formatExpiration(status.min_expiration)}</span>
            </span>
          )}
        </div>

        <button
          onClick={toggleExpand}
          title={expanded ? 'Contraer' : 'Expandir'}
          aria-label={expanded ? 'Contraer cookies' : 'Expandir cookies'}
          aria-expanded={expanded}
          className={`flex items-center justify-center flex-shrink-0 transition-all active:scale-95 rounded-full ${glassPill} hover:bg-white/10`}
          style={{
            width: iconBtnSize,
            height: iconBtnSize,
            color: expanded ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.7)',
            cursor: 'pointer',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 150ms ease',
            }}
          >
            <ChevronDown size={14} strokeWidth={1.5} />
          </span>
        </button>
      </div>

      {/* ── FIX_1: INTERNAL SESSION PANEL (replaces new-tab Google Maps opener) ── */}
      {showSessionPanel && (
        <div
          className={`mt-2 rounded-2xl p-3 ${glassPill}`}
          style={{ animation: 'cookiesExpand 150ms ease-out' }}
        >
          <div className="flex items-center gap-1.5 mb-2" style={{ fontSize: 10, color: 'rgba(255,255,255,.55)', fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            <Sparkles size={11} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.7)' }} />
            <span>Sesión Google</span>
          </div>
          <ol className="space-y-1 mb-2.5" style={{ fontSize: 'clamp(9px, 1.9vw, 11px)', color: 'rgba(255,255,255,.7)', lineHeight: 1.5 }}>
            <li className="flex gap-1.5"><span className="tabular-nums" style={{ color: 'rgba(255,255,255,.5)' }}>1.</span><span>Abrí Google Maps y copiá las cookies (DevTools o extensión).</span></li>
            <li className="flex gap-1.5"><span className="tabular-nums" style={{ color: 'rgba(255,255,255,.5)' }}>2.</span><span>Volvé a esta pestaña — la auto-detección las importa solo.</span></li>
            <li className="flex gap-1.5"><span className="tabular-nums" style={{ color: 'rgba(255,255,255,.5)' }}>3.</span><span>O pegalas manualmente con el botón Expandir de abajo.</span></li>
          </ol>
          <div className="flex gap-1.5">
            {/* FIX_PREVIEW_04 (stracker_core_ui): no target='_blank' / no new tab.
                Single primary action copies the Maps URL so the user stays in the
                SPA and pastes it manually — app state is never lost. */}
            <button
              onClick={copyMapsUrl}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-full transition-all active:scale-95 hover:bg-white/10"
              style={{
                background: 'rgba(255,255,255,.08)',
                border: '1px solid rgba(255,255,255,.15)',
                color: 'rgba(255,255,255,.9)',
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: '0.04em',
                cursor: 'pointer',
              }}
            >
              <Copy size={11} strokeWidth={1.5} />
              <span>Copiar URL de Google Maps</span>
            </button>
          </div>
        </div>
      )}

      {/* ── V9: TTL STRIP — 2px bar integrated into the collapsed row ── */}
      {minExp != null && !expanded && (
        <div
          style={{
            height: 2,
            borderRadius: 1,
            background: 'rgba(255,255,255,.06)',
            overflow: 'hidden',
            marginTop: 2,
          }}
          title={`Sesión expira en ${formatExpiration(minExp)}`}
        >
          <div
            style={{
              height: '100%',
              width: `${ttlFraction * 100}%`,
              background: ttlColor,
              transition: 'width 60s linear, background 1s ease',
              boxShadow: `0 0 4px ${ttlColor}`,
            }}
          />
        </div>
      )}

      {/* ── V9: TTL detail (only shown when expanded) ── */}
      {minExp != null && expanded && (
        <div className="mt-1.5" style={{ paddingLeft: 2, paddingRight: 2 }}>
          <div
            style={{
              height: 3,
              borderRadius: 2,
              background: 'rgba(255,255,255,.06)',
              overflow: 'hidden',
            }}
            title={`Sesión expira en ${formatExpiration(minExp)}`}
          >
            <div
              style={{
                height: '100%',
                width: `${ttlFraction * 100}%`,
                background: ttlColor,
                transition: 'width 60s linear, background 1s ease',
                boxShadow: `0 0 6px ${ttlColor}`,
              }}
            />
          </div>
          <div
            className="flex justify-between mt-0.5"
            style={{ fontSize: 8, color: 'rgba(255,255,255,.3)', fontFamily: 'ui-monospace, monospace' }}
          >
            <span>TTL</span>
            <span style={{ color: ttlColor }}>{formatExpiration(minExp)}</span>
          </div>
        </div>
      )}

      {/* ── EXPANDED: textarea + IMPORTAR (manual fallback) ── */}
      {expanded && !forceCollapse && !isShortViewport && (
        <div
          style={{
            animation: 'cookiesExpand 150ms ease-out',
            marginTop: 6,
          }}
        >
          {/* T4 hint: auto-detect is active */}
          <div
            className={`mb-1.5 px-2 py-1 rounded-xl flex items-center gap-1.5 ${glassPill}`}
            style={{
              fontSize: 'clamp(8px, 1.8vw, 10px)',
              color: 'rgba(255,255,255,.7)',
            }}
          >
            <Sparkles size={11} strokeWidth={1.5} />
            <span>Auto-detección activa — copiá cookies y volvé a esta pestaña</span>
          </div>

          <textarea
            value={pasteValue}
            onChange={(e) => { setPasteValue(e.target.value); setImportResult(null) }}
            placeholder="Pegá cookies acá (JSON, Header String o Netscape)… o simplemente copialas y volvé"
            rows={isMobile ? 2 : 3}
            className="w-full rounded-xl p-2 resize-none"
            style={{
              background: 'rgba(0,0,0,.4)',
              border: '1px solid rgba(255,255,255,.05)',
              color: 'rgba(255,255,255,.8)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 'clamp(9px, 1.8vw, 11px)',
              lineHeight: 1.4,
            }}
            spellCheck={false}
            autoFocus
          />

          <button
            onClick={handleManualImport}
            disabled={importing || !pasteValue.trim()}
            className="w-full flex items-center justify-center gap-1.5 mt-1.5 py-2 rounded-full transition-all active:scale-95 hover:bg-white/10"
            style={{
              background: importing ? 'rgba(255,255,255,.15)' : 'rgba(255,255,255,.08)',
              border: '1px solid rgba(255,255,255,.2)',
              color: 'rgba(255,255,255,.9)',
              fontSize: 'clamp(10px, 2.2vw, 12px)',
              fontWeight: 600,
              cursor: importing ? 'wait' : 'pointer',
              opacity: (!pasteValue.trim() && !importing) ? 0.4 : 1,
              letterSpacing: '0.08em',
            }}
          >
            {importing ? <><Hourglass size={13} strokeWidth={1.5} className="animate-spin" /> Importando…</> : <><Download size={13} strokeWidth={1.5} /> IMPORTAR</>}
          </button>

          {importResult && importResult.status === 'ok' && (
            <div
              className={`mt-1.5 p-2 rounded-xl ${glassPill}`}
              style={{
                fontSize: 'clamp(8px, 1.8vw, 10px)',
                lineHeight: 1.5,
              }}
            >
              <div className="flex items-center gap-1" style={{ color: 'rgba(255,255,255,.85)', fontWeight: 600, marginBottom: 2 }}>
                {importResult.has_critical ? <CircleCheck size={12} strokeWidth={1.5} /> : <TriangleAlert size={12} strokeWidth={1.5} />}
                <span>{importResult.count} cookies · {importResult.has_critical ? 'sesión completa' : 'incompleta'}</span>
              </div>
              <div style={{ color: 'rgba(255,255,255,.5)' }}>
                Antes: {importResult.old_count} → Ahora: {importResult.count}
                {importResult.more_complete ? ' · más completa' : ''}
              </div>
              {!importResult.has_critical && (importResult.missing_critical?.length || 0) > 0 && (
                <div className="flex items-center gap-1" style={{ color: 'rgba(255,255,255,.6)', marginTop: 2, fontWeight: 500 }}>
                  <TriangleAlert size={11} strokeWidth={1.5} />
                  <span>Faltan: {importResult.missing_critical!.join(', ')}</span>
                </div>
              )}
            </div>
          )}

          {importResult && importResult.status === 'error' && (
            <div
              className={`mt-1.5 p-2 rounded-xl flex items-center gap-1.5 ${glassPill}`}
              style={{
                color: 'rgba(255,255,255,.7)',
                fontSize: 'clamp(8px, 1.8vw, 10px)',
              }}
            >
              <CircleX size={12} strokeWidth={1.5} />
              <span>{importResult.error}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
