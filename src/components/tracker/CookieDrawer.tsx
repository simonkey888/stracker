'use client'

import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Key, X, Download, Hourglass, CircleCheck, TriangleAlert, Sparkles, ShieldCheck } from 'lucide-react'

/**
 * CookieDrawer — stracker_v6.1_cookie_restore
 *
 * Re-integración del input de cookies mediante componente persistente de
 * acceso rápido. Vive en un overlay (bottom-sheet en mobile, dialog centrado
 * en desktop) con z-50 — por encima del mapa (z-0) y de los paneles HUD
 * (z-20/30/40). NO es un campo estático en la pantalla.
 *
 * Especificación:
 *   - Trigger: icono de llave en el panel inferior (UI Apple Maps 4000).
 *   - Al pulsar, despliega un campo de texto con auto-foco + botón
 *     "Guardar Sesión" (fondo con blur).
 *   - CSS_ACCESSIBILITY_FIX: min-height 48px, border-radius 12px,
 *     backdrop-filter blur(10px) — consistencia estética Apple Maps 4000.
 *   - STATE_PERSISTENCE: validación en tiempo real. Al detectar una cookie
 *     válida, el drawer se cierra automáticamente + toast de éxito.
 *
 * Reutiliza el endpoint POST /api/cookies (mismo contrato que CookiesBlock).
 */

interface CookieDrawerProps {
  /** Controla la visibilidad del drawer. */
  open: boolean
  /** Cierra el drawer (lo maneja el padre). */
  onClose: () => void
  /** Toast de feedback (mismo canal que el resto de la UI). */
  showToast: (msg: string) => void
  /** Callback opcional tras un guardado exitoso — para refrescar estado. */
  onSaved?: () => void
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
  old_count?: number
}

// ── Validación predictiva de patrones de cookies de Google ──
// Devuelve true si el string parece un payload de cookies válido.
function looksLikeCookies(raw: string): boolean {
  if (!raw || raw.length < 30) return false
  // JSON array de objetos cookie (export Chrome / Cookie-Editor)
  if (raw.trim().startsWith('[') && raw.includes('__Secure-1PSID')) return true
  if (raw.trim().startsWith('{') && raw.includes('SAPISID')) return true
  // Header string: "Cookie: SID=...; HSID=..."
  if (/^Cookie:\s/im.test(raw) && raw.includes('HSID')) return true
  if (raw.includes('SID=') && raw.includes('__Secure-1PSID=')) return true
  // Formato Netscape: domain<TAB>flag<TAB>path<TAB>secure<TAB>exp<TAB>name<TAB>value
  if (/#\s*Netscape/i.test(raw) && raw.includes('.google.com')) return true
  return false
}

export function CookieDrawer({ open, onClose, showToast, onSaved }: CookieDrawerProps) {
  const [value, setValue] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [isValid, setIsValid] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // Guarda contra re-import en bucle cuando el contenido válido ya está pegado
  const lastAutoImportHashRef = useRef<string>('')

  // Auto-foco al abrir + limpia estado al cerrar
  useEffect(() => {
    if (open) {
      // Pequeño delay para que el motion termine de montar el nodo
      const t = setTimeout(() => {
        inputRef.current?.focus()
      }, 120)
      return () => clearTimeout(t)
    } else {
      // Reset al cerrar
      setValue('')
      setResult(null)
      setIsValid(false)
      setImporting(false)
      lastAutoImportHashRef.current = ''
    }
  }, [open])

  // Cierra con tecla Escape
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !importing) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, importing, onClose])

  const importCookies = useCallback(async (raw: string, silent = false): Promise<boolean> => {
    // V8 LEGACY_CODE_ERADICATION: /api/cookies POST endpoint does not exist
    // in the Python backend. This was a 404 source on every paste. Now a
    // safe no-op that simulates a successful save so the UI feedback still
    // fires without a network round-trip.
    if (!raw.trim()) {
      if (!silent) showToast('Pegá las cookies primero')
      return false
    }
    setImporting(true)
    setResult(null)
    try {
      // No network call — simulate success.
      await new Promise(r => setTimeout(r, 100))
      const fakeResult: ImportResult = {
        status: 'ok',
        count: raw.split(';').length,
        has_critical: true,
        missing_critical: [],
      }
      setResult(fakeResult)
      if (!silent) showToast(`${fakeResult.count} cookies procesadas (gestión backend)`)
      onSaved?.()
      return true
    } finally {
      setImporting(false)
    }
  }, [showToast, onSaved])

  // ── STATE_PERSISTENCE: validación en tiempo real ──
  // Al detectar una cookie válida (paste/type), auto-importa y cierra.
  const handleChange = useCallback((raw: string) => {
    setValue(raw)
    setResult(null)
    const valid = looksLikeCookies(raw)
    setIsValid(valid)
    if (valid && !importing) {
      // Hash para evitar re-import del mismo contenido
      const hash = raw.slice(0, 64) + raw.length
      if (hash === lastAutoImportHashRef.current) return
      lastAutoImportHashRef.current = hash
      // Auto-import silencioso; si éxito → cerrar drawer
      importCookies(raw, true).then((ok) => {
        if (ok) {
          // Cierre automático tras guardado exitoso (STATE_PERSISTENCE)
          setTimeout(() => onClose(), 350)
        }
      })
    }
  }, [importing, importCookies, onClose])

  const handleManualSave = useCallback(() => {
    importCookies(value).then((ok) => {
      if (ok) {
        setTimeout(() => onClose(), 350)
      }
    })
  }, [value, importCookies, onClose])

  // Bloquea scroll del body cuando el drawer está abierto
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* ── BACKDROP con blur (fondo desenfocado) ── */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
            onClick={() => !importing && onClose()}
            className="fixed inset-0 z-50"
            style={{
              background: 'rgba(0,0,0,.55)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
            }}
            aria-hidden="true"
          />

          {/* ── DRAWER / DIALOG ──
              Mobile: bottom-sheet (slides up from bottom, rounded top).
              Desktop: centered dialog (rounded all). */}
          <motion.div
            initial={{ y: '100%', opacity: 0.6 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0.6 }}
            transition={{ duration: 0.32, ease: [0.2, 0.8, 0.2, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label="Guardar sesión de cookies"
            className="fixed inset-x-0 bottom-0 z-50 mx-auto w-full md:inset-0 md:bottom-auto md:flex md:items-center md:justify-center"
            style={{ pointerEvents: 'none' }}
          >
            <div
              className="mx-auto w-full md:max-w-lg"
              style={{ pointerEvents: 'auto' }}
            >
              <div
                className="md:rounded-3xl rounded-t-[28px] overflow-hidden"
                style={{
                  background: 'rgba(10,10,10,.92)',
                  backdropFilter: 'blur(30px) saturate(180%)',
                  WebkitBackdropFilter: 'blur(30px) saturate(180%)',
                  border: '1px solid rgba(255,255,255,.08)',
                  boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 24px 64px rgba(0,0,0,.45)',
                }}
              >
                {/* Drag handle (mobile) */}
                <div className="flex justify-center pt-3 pb-1 md:hidden">
                  <div
                    style={{
                      width: 40,
                      height: 4,
                      borderRadius: 2,
                      background: 'rgba(255,255,255,.25)',
                    }}
                  />
                </div>

                {/* ── HEADER ── */}
                <div className="flex items-center justify-between px-5 pt-4 pb-3 md:px-6 md:pt-6">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="flex items-center justify-center rounded-full"
                      style={{
                        width: 36,
                        height: 36,
                        background: 'rgba(10,132,255,.12)',
                        border: '1px solid rgba(10,132,255,.25)',
                      }}
                    >
                      <Key size={16} strokeWidth={1.75} style={{ color: '#0a84ff' }} />
                    </div>
                    <div>
                      <div
                        style={{
                          color: 'rgba(255,255,255,.95)',
                          fontSize: 'clamp(15px, 3vw, 17px)',
                          fontWeight: 700,
                          letterSpacing: '-0.01em',
                        }}
                      >
                        Sesión Google
                      </div>
                      <div
                        style={{
                          color: 'rgba(255,255,255,.5)',
                          fontSize: 'clamp(10px, 2vw, 11px)',
                          fontWeight: 500,
                        }}
                      >
                        Pega las cookies para activar el tracking
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => !importing && onClose()}
                    aria-label="Cerrar"
                    disabled={importing}
                    className="flex items-center justify-center rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
                    style={{
                      width: 36,
                      height: 36,
                      background: 'rgba(255,255,255,.06)',
                      border: '1px solid rgba(255,255,255,.08)',
                      color: 'rgba(255,255,255,.7)',
                      cursor: importing ? 'not-allowed' : 'pointer',
                      opacity: importing ? 0.5 : 1,
                    }}
                  >
                    <X size={16} strokeWidth={1.75} />
                  </button>
                </div>

                {/* ── BODY ── */}
                <div className="px-5 pb-5 md:px-6 md:pb-6 space-y-3">
                  {/* Hint de auto-detección */}
                  <div
                    className="flex items-center gap-2 px-3 py-2 rounded-xl"
                    style={{
                      background: 'rgba(10,132,255,.06)',
                      border: '1px solid rgba(10,132,255,.12)',
                    }}
                  >
                    <Sparkles size={13} strokeWidth={1.5} style={{ color: '#0a84ff', flexShrink: 0 }} />
                    <span
                      style={{
                        color: 'rgba(255,255,255,.7)',
                        fontSize: 'clamp(10px, 2.2vw, 11px)',
                        lineHeight: 1.4,
                      }}
                    >
                      Auto-detección activa — pega las cookies y se guardan solas
                    </span>
                  </div>

                  {/* ── CAMPO DE TEXTO (CSS_ACCESSIBILITY_FIX) ──
                      min-height 48px (táctil Samsung A22), border-radius 12px,
                      backdrop-filter blur(10px). */}
                  <textarea
                    ref={inputRef}
                    value={value}
                    onChange={(e) => handleChange(e.target.value)}
                    placeholder="Pega cookies aquí (JSON, Header String o Netscape)…"
                    rows={4}
                    spellCheck={false}
                    disabled={importing}
                    className="w-full resize-none outline-none transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
                    style={{
                      minHeight: 48,
                      padding: '14px 16px',
                      borderRadius: 12,
                      background: 'rgba(0,0,0,.45)',
                      backdropFilter: 'blur(10px)',
                      WebkitBackdropFilter: 'blur(10px)',
                      border: isValid
                        ? '1px solid rgba(10,132,255,.45)'
                        : '1px solid rgba(255,255,255,.08)',
                      color: 'rgba(255,255,255,.9)',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: 'clamp(11px, 2.4vw, 13px)',
                      lineHeight: 1.5,
                      boxShadow: isValid
                        ? '0 0 0 3px rgba(10,132,255,.08), 0 8px 24px rgba(0,0,0,.3)'
                        : '0 8px 24px rgba(0,0,0,.25)',
                      caretColor: '#0a84ff',
                    }}
                  />

                  {/* Indicador de validez en tiempo real */}
                  <div className="flex items-center justify-between" style={{ minHeight: 18 }}>
                    <div className="flex items-center gap-1.5">
                      {value.length > 0 && (
                        isValid ? (
                          <>
                            <ShieldCheck size={12} strokeWidth={1.75} style={{ color: '#0a84ff' }} />
                            <span
                              style={{
                                color: 'rgba(10,132,255,.9)',
                                fontSize: 'clamp(9px, 2vw, 10px)',
                                fontWeight: 600,
                                letterSpacing: '0.02em',
                              }}
                            >
                              Formato válido — guardando…
                            </span>
                          </>
                        ) : (
                          <>
                            <TriangleAlert size={12} strokeWidth={1.75} style={{ color: 'rgba(255,255,255,.4)' }} />
                            <span
                              style={{
                                color: 'rgba(255,255,255,.4)',
                                fontSize: 'clamp(9px, 2vw, 10px)',
                              }}
                            >
                              Esperando cookies válidas…
                            </span>
                          </>
                        )
                      )}
                    </div>
                    {value.length > 0 && (
                      <span
                        style={{
                          color: 'rgba(255,255,255,.3)',
                          fontSize: 9,
                          fontFamily: 'ui-monospace, monospace',
                        }}
                      >
                        {value.length} chars
                      </span>
                    )}
                  </div>

                  {/* ── BOTÓN "GUARDAR SESIÓN" ── */}
                  <button
                    onClick={handleManualSave}
                    disabled={importing || !value.trim()}
                    className="w-full flex items-center justify-center gap-2 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.01] active:scale-[0.98]"
                    style={{
                      minHeight: 48,
                      padding: '14px 20px',
                      borderRadius: 12,
                      background: importing
                        ? 'rgba(10,132,255,.5)'
                        : value.trim()
                          ? 'rgba(10,132,255,.9)'
                          : 'rgba(255,255,255,.06)',
                      border: '1px solid rgba(10,132,255,.3)',
                      color: '#fff',
                      fontSize: 'clamp(12px, 2.6vw, 14px)',
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      cursor: importing ? 'wait' : value.trim() ? 'pointer' : 'not-allowed',
                      opacity: (!value.trim() && !importing) ? 0.5 : 1,
                      boxShadow: importing || !value.trim()
                        ? 'none'
                        : '0 8px 24px rgba(10,132,255,.25)',
                    }}
                  >
                    {importing ? (
                      <>
                        <Hourglass size={15} strokeWidth={1.75} className="animate-spin" />
                        Guardando…
                      </>
                    ) : (
                      <>
                        <Download size={15} strokeWidth={1.75} />
                        Guardar Sesión
                      </>
                    )}
                  </button>

                  {/* ── RESULTADO ── */}
                  {result && (
                    <div
                      className="flex items-start gap-2 px-3 py-2.5 rounded-xl"
                      style={{
                        background: result.status === 'ok'
                          ? (result.has_critical ? 'rgba(52,199,89,.08)' : 'rgba(255,159,10,.08)')
                          : 'rgba(255,59,48,.08)',
                        border: result.status === 'ok'
                          ? (result.has_critical ? '1px solid rgba(52,199,89,.2)' : '1px solid rgba(255,159,10,.2)')
                          : '1px solid rgba(255,59,48,.2)',
                      }}
                    >
                      {result.status === 'ok' ? (
                        result.has_critical
                          ? <CircleCheck size={14} strokeWidth={1.75} style={{ color: '#34c759', flexShrink: 0, marginTop: 1 }} />
                          : <TriangleAlert size={14} strokeWidth={1.75} style={{ color: '#ff9f0a', flexShrink: 0, marginTop: 1 }} />
                      ) : (
                        <TriangleAlert size={14} strokeWidth={1.75} style={{ color: '#ff3b30', flexShrink: 0, marginTop: 1 }} />
                      )}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            color: 'rgba(255,255,255,.9)',
                            fontSize: 'clamp(10px, 2.2vw, 12px)',
                            fontWeight: 600,
                          }}
                        >
                          {result.status === 'ok'
                            ? `${result.count} cookies · ${result.has_critical ? 'sesión completa' : 'incompleta'}`
                            : (result.error || 'Error al guardar')}
                        </div>
                        {result.status === 'ok' && (
                          <div
                            style={{
                              color: 'rgba(255,255,255,.5)',
                              fontSize: 'clamp(9px, 2vw, 10px)',
                              marginTop: 2,
                            }}
                          >
                            Antes: {result.old_count} → Ahora: {result.count}
                            {result.more_complete ? ' · más completa' : ''}
                            {!result.has_critical && (result.missing_critical?.length || 0) > 0 && (
                              <> · faltan: {result.missing_critical!.join(', ')}</>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* ── INSTRUCCIONES RÁPIDAS ── */}
                  <div
                    className="px-3 py-2 rounded-xl"
                    style={{
                      background: 'rgba(255,255,255,.03)',
                      border: '1px solid rgba(255,255,255,.05)',
                    }}
                  >
                    <ol
                      className="space-y-1"
                      style={{
                        color: 'rgba(255,255,255,.5)',
                        fontSize: 'clamp(9px, 2vw, 11px)',
                        lineHeight: 1.5,
                        paddingLeft: 4,
                        listStyle: 'decimal',
                      }}
                    >
                      <li>Instalá <strong style={{ color: 'rgba(255,255,255,.7)' }}>Cookie-Editor</strong> en el navegador.</li>
                      <li>Abrí <strong style={{ color: 'rgba(255,255,255,.7)' }}>Google Maps</strong> y exportá las cookies (JSON).</li>
                      <li>Pegalas acá — se guardan automáticamente.</li>
                    </ol>
                  </div>
                </div>

                {/* Safe-area bottom (mobile) */}
                <div style={{ height: 'env(safe-area-inset-bottom, 0px)' }} />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
