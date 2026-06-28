'use client'

import { useState, useCallback } from 'react'

/**
 * GeminiJsonViewer — Muestra el mega JSON de análisis con botón "Copiar para Gemini".
 *
 * Contexto: el usuario pidió un análisis profundo del proyecto STRACKER para
 * inyectarlo en Gemini. Este componente muestra el JSON con sintaxis bonita,
 * un botón grande de copiar al portapapeles, y un toggle para volver a la app.
 */
export function GeminiJsonViewer() {
  const [copied, setCopied] = useState(false)
  const [showStracker, setShowStracker] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      const resp = await fetch('/gemini-analysis-input.json', { cache: 'no-store' })
      const text = await resp.text()
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch (err) {
      // Fallback: crear textarea temporal y seleccionar
      console.error('Clipboard falló, intentando método fallback', err)
      try {
        const resp = await fetch('/gemini-analysis-input.json', { cache: 'no-store' })
        const text = await resp.text()
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        setCopied(true)
        setTimeout(() => setCopied(false), 2500)
      } catch (e2) {
        console.error('Fallback también falló', e2)
        alert('No se pudo copiar automáticamente. Descarga el JSON desde /gemini-analysis-input.json')
      }
    }
  }, [])

  const handleDownload = useCallback(async () => {
    try {
      const resp = await fetch('/gemini-analysis-input.json', { cache: 'no-store' })
      const text = await resp.text()
      const blob = new Blob([text], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'gemini-analysis-input.json'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Download falló', err)
    }
  }, [])

  const handleViewStracker = useCallback(() => {
    setShowStracker(true)
  }, [])

  if (showStracker) {
    // Cargar TrackerView dinámicamente solo si el usuario hace clic
    const TrackerView = require('./TrackerView').default
    return <TrackerView />
  }

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: '#0b0f14', color: '#f5f5f7', fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif' }}
    >
      {/* Header sticky */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b"
        style={{
          background: 'rgba(11,15,20,.85)',
          backdropFilter: 'blur(24px) saturate(180%)',
          WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          borderColor: 'rgba(255,255,255,.08)',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ fontSize: 20 }}>🧠</span>
          <div className="min-w-0">
            <h1 className="font-bold text-sm truncate" style={{ letterSpacing: '-0.01em' }}>
              STRACKER — Análisis para Gemini
            </h1>
            <p className="text-[10px] truncate" style={{ color: 'rgba(255,255,255,.45)' }}>
              Mega JSON pipeline · 10 problemas · 8 soluciones · 10 mejoras atómicas
            </p>
          </div>
        </div>
        <button
          onClick={handleViewStracker}
          className="flex-shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all active:scale-95"
          style={{
            background: 'rgba(28,28,35,.6)',
            border: '1px solid rgba(255,255,255,.1)',
            color: 'rgba(255,255,255,.7)',
          }}
        >
          ← Ver STRACKER
        </button>
      </header>

      {/* Contenido scrolleable */}
      <main className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
        {/* Hero con botón copiar gigante */}
        <section className="px-4 py-6 flex flex-col items-center text-center">
          <div
            className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full mb-4"
            style={{
              background: 'rgba(10,132,255,.1)',
              border: '1px solid rgba(10,132,255,.25)',
              color: '#0a84ff',
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.08em',
            }}
          >
            <span>●</span>
            <span>LISTO PARA INYECTAR</span>
          </div>

          <h2
            className="font-bold mb-2"
            style={{ fontSize: 'clamp(20px, 4vw, 28px)', letterSpacing: '-0.02em', lineHeight: 1.15 }}
          >
            Mega JSON de Análisis
          </h2>
          <p
            className="mb-6 max-w-md"
            style={{ fontSize: 13, color: 'rgba(255,255,255,.55)', lineHeight: 1.5 }}
          >
            Copia el JSON completo y pégalo en Gemini. Incluye arquitectura, engines, UI, 10 problemas
            identificados, 8 soluciones propuestas, 10 mejoras atómicas priorizadas, matriz de verificación
            y 10 preguntas específicas para Gemini.
          </p>

          {/* Botón COPIAR gigante */}
          <button
            onClick={handleCopy}
            className="w-full max-w-sm flex items-center justify-center gap-2 py-4 rounded-2xl font-bold transition-all active:scale-95"
            style={{
              background: copied
                ? 'linear-gradient(135deg, #30d158 0%, #34c759 100%)'
                : 'linear-gradient(135deg, #0a84ff 0%, #007aff 100%)',
              color: '#fff',
              fontSize: 15,
              letterSpacing: '0.04em',
              boxShadow: copied
                ? '0 8px 24px rgba(48,209,88,.35)'
                : '0 8px 24px rgba(10,132,255,.35)',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            {copied ? (
              <>
                <span style={{ fontSize: 18 }}>✓</span>
                <span>¡COPIADO! Pega en Gemini</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 18 }}>📋</span>
                <span>COPIAR JSON PARA GEMINI</span>
              </>
            )}
          </button>

          {/* Botón secundario descargar */}
          <button
            onClick={handleDownload}
            className="mt-3 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-[11px] font-semibold transition-all active:scale-95"
            style={{
              background: 'rgba(28,28,35,.6)',
              border: '1px solid rgba(255,255,255,.1)',
              color: 'rgba(255,255,255,.65)',
              cursor: 'pointer',
            }}
          >
            <span>⬇</span>
            <span>Descargar .json</span>
          </button>

          {/* Stats rápidas */}
          <div
            className="grid grid-cols-3 gap-2 mt-6 w-full max-w-sm"
          >
            {[
              { num: '10', label: 'Problemas', color: '#ff453a' },
              { num: '8', label: 'Soluciones', color: '#ff9f0a' },
              { num: '10', label: 'Mejoras atómicas', color: '#30d158' },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-xl py-3 px-2 text-center"
                style={{
                  background: 'rgba(28,28,35,.5)',
                  border: `1px solid ${s.color}25`,
                }}
              >
                <div className="font-bold" style={{ fontSize: 20, color: s.color }}>{s.num}</div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,.5)', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Preview del JSON */}
        <section className="px-4 pb-8">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-bold text-xs uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.55)' }}>
              Preview del JSON
            </h3>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,.35)' }}>(recortado)</span>
          </div>
          <pre
            className="rounded-xl p-3 overflow-x-auto text-[10px] leading-relaxed"
            style={{
              background: 'rgba(0,0,0,.4)',
              border: '1px solid rgba(255,255,255,.06)',
              color: '#30d158',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              maxHeight: '320px',
              scrollbarWidth: 'thin',
            }}
          >
{`{
  "_meta": {
    "doc": "STRACKER — Análisis completo para Gemini",
    "version": "V9-local (post Gemini roast T1-T6)",
    "deploy_target": "Render free tier (512MB RAM)"
  },
  "architecture": {
    "summary": "Tracker Google Maps Location Sharing con motor bayesiano...",
    "layers": [
      "L1 RAW INGESTION — tracking_loop + _fetch_location (RPC Google)",
      "L2 STATE ENGINE — build_state 11 pasos (movement→zone→...→ghostrail)",
      "L3 UI RENDERER — TrackerView Next.js (render(state) ONLY)"
    ]
  },
  "engines": {
    "state_engine": { "pipeline_11_steps": [...] },
    "spoof_engine": { "signals": [...10 signals...], "ca1_status": "APLICADO" },
    "ghostrail_engine": { "version": "V7", "osrm": "router.project-osrm.org" },
    "cookie_engine": { "critical_keys": ["SID","HSID","SSID","SAPISID","__Secure-3PSID"] },
    "osrm_engine": { "duplicate": "Python + TypeScript (DUPLICADO)" },
    "polling_engine": { "ca3_status": "APLICADO 3s/10s adaptativo" }
  },
  "current_problems": [
    "P1 ALTA — generate_html() dead code pero CPU waste activo (450 líneas)",
    "P2 ALTA — Backend Python caído en dev (ECONNREFUSED :3003)",
    "P3 MEDIA — wsConnected es flag HTTP, no WebSocket real",
    "P4 MEDIA — Duplicación código OSRM Python + TypeScript",
    "P5 MEDIA — TrackerView.tsx 2337 líneas God Component",
    "P6 MEDIA — 4 pases de CSV por poll (CPU + IO)",
    "P7 BAJA — vaul instalado pero NO usado",
    "P8 BAJA — No hay WebSocket real, latencia hasta 10s",
    "P9 BAJA — Spoof signals no persisten entre restarts",
    "P10 BAJA — Nominatim reverse geocode sin rate limit"
  ],
  "possible_solutions": [8 soluciones con approach, risk, effort...],
  "atomic_improvements": [10 mejoras priorizadas 1-5 con files, lines, risk...],
  "verification_matrix": [8 viewports verificados...],
  "questions_for_gemini": [10 preguntas específicas...],
  "execution_plan_proposed": {
    "phase_1_quirugico_safe": ["A1","A2","A3","A6"],
    "phase_2_refactor_motor": ["A4","A5","A7"],
    "phase_3_ui_polish": ["A8","A9","A10"],
    "phase_4_deploy_verify": ["Push GitHub","Render deploy","Agent Browser"]
  }
}`}
          </pre>
        </section>

        {/* Instrucciones */}
        <section className="px-4 pb-8">
          <div
            className="rounded-xl p-4"
            style={{
              background: 'rgba(48,209,88,.05)',
              border: '1px solid rgba(48,209,88,.15)',
            }}
          >
            <h3 className="font-bold text-xs mb-2" style={{ color: '#30d158', letterSpacing: '0.04em' }}>
              ▸ CÓMO USAR
            </h3>
            <ol className="space-y-1.5" style={{ fontSize: 12, color: 'rgba(255,255,255,.7)', lineHeight: 1.5 }}>
              <li><strong style={{ color: '#30d158' }}>1.</strong> Clic en <strong>COPIAR JSON PARA GEMINI</strong> (arriba)</li>
              <li><strong style={{ color: '#30d158' }}>2.</strong> Abrir Gemini (gemini.google.com)</li>
              <li><strong style={{ color: '#30d158' }}>3.</strong> Pegar + prompt: <em style={{ color: 'rgba(255,255,255,.9)' }}>"Analizá este JSON de mi app STRACKER. Devolveme tu roast estructurado con hallazgos (T1), correcciones atómicas (T2), rediseños UI (T3), decisiones (T4), magias (T5) y matriz verificación (T6). Sé técnico y específico."</em></li>
              <li><strong style={{ color: '#30d158' }}>4.</strong> Volver acá con la respuesta de Gemini y la discutimos</li>
            </ol>
          </div>
        </section>
      </main>

      {/* Footer sticky */}
      <footer
        className="px-4 py-2.5 border-t flex items-center justify-between"
        style={{
          background: 'rgba(11,15,20,.85)',
          backdropFilter: 'blur(24px)',
          borderColor: 'rgba(255,255,255,.06)',
          fontSize: 10,
          color: 'rgba(255,255,255,.4)',
        }}
      >
        <span>stracker · V9-local · análisis Z.ai Code</span>
        <span>~15KB JSON</span>
      </footer>
    </div>
  )
}
