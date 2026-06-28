'use client'

import { useEffect, useState } from 'react'
import { Sunrise } from 'lucide-react'

/**
 * MapStyleInyector — MC_8_02 (stracker_v8_hyper_premium)
 *
 * Motor de Iluminación Circadiana (Time-of-Day Engine).
 *
 * An invisible overlay (pointer-events-none) layered above the Leaflet tile
 * pane but below the marker pane. Applies a mix-blend-mode color wash that
 * transmits the real atmospheric feel of the target's surroundings based on
 * the local time of day (Santa Fe, America/Argentina/Buenos_Aires = UTC-3).
 *
 * Bands (local hour 0–23):
 *   Night        00:00–06:00  → brightness(0.72) sepia(1) hue-rotate(180deg)
 *   Dawn         06:00–08:00  → warm gold tint  (rgba orange, blend 18%)
 *   Day          08:00–18:00  → no filter (high contrast, clean)
 *   Golden Hour  18:00–19:30  → amber wash (blend 22%)
 *   Dusk         19:30–21:00  → purple/magenta (blend 25%)
 *   Night        21:00–24:00  → deep night mode
 *
 * Re-evaluates every 60s so the wash transitions naturally as the day
 * progresses. Transition is CSS-eased over 4s for a smooth handoff.
 *
 * Z-index: 200 — above .leaflet-tile-pane (100) but below .leaflet-overlay-pane
 * (400) and .leaflet-marker-pane (9999). Markers + routes stay crisp; only
 * the base map tiles get the atmospheric wash.
 */

type Phase =
  | 'night_deep'
  | 'dawn'
  | 'day'
  | 'golden'
  | 'dusk'
  | 'night'

interface PhaseStyle {
  background: string
  mixBlendMode: React.CSSProperties['mixBlendMode']
  opacity: number
}

const PHASE_STYLES: Record<Phase, PhaseStyle> = {
  night_deep: {
    // Deep night: hue-rotate towards cold blue, dim brightness
    background: 'rgba(8, 12, 30, 0.35)',
    mixBlendMode: 'multiply',
    opacity: 1,
  },
  dawn: {
    // Dawn: warm gold/orange wash
    background: 'linear-gradient(180deg, rgba(255,167,38,0.22) 0%, rgba(255,214,10,0.10) 60%, rgba(0,0,0,0) 100%)',
    mixBlendMode: 'soft-light',
    opacity: 1,
  },
  day: {
    // Day: no filter — high contrast clean
    background: 'transparent',
    mixBlendMode: 'normal',
    opacity: 0,
  },
  golden: {
    // Golden hour: amber wash low on the horizon
    background: 'linear-gradient(180deg, rgba(255,159,10,0.20) 0%, rgba(255,109,0,0.12) 50%, rgba(0,0,0,0) 100%)',
    mixBlendMode: 'overlay',
    opacity: 1,
  },
  dusk: {
    // Dusk: purple/magenta
    background: 'linear-gradient(180deg, rgba(191,90,242,0.22) 0%, rgba(255,55,95,0.14) 60%, rgba(0,0,0,0) 100%)',
    mixBlendMode: 'overlay',
    opacity: 1,
  },
  night: {
    // Night (post-dusk): deep cold
    background: 'rgba(10, 14, 40, 0.40)',
    mixBlendMode: 'multiply',
    opacity: 1,
  },
}

function computePhase(date: Date): Phase {
  const h = date.getHours()
  const m = date.getMinutes()
  const hoursDecimal = h + m / 60

  if (hoursDecimal < 6) return 'night_deep'
  if (hoursDecimal < 8) return 'dawn'
  if (hoursDecimal < 18) return 'day'
  if (hoursDecimal < 19.5) return 'golden'
  if (hoursDecimal < 21) return 'dusk'
  return 'night'
}

const PHASE_LABEL: Record<Phase, string> = {
  night_deep: 'NOCHE',
  dawn: 'AMANECER',
  day: 'DÍA',
  golden: 'HORA DORADA',
  dusk: 'ATARDECER',
  night: 'NOCHE',
}

interface MapStyleInyectorProps {
  /** The current local Date — injected so TrackerView can pass a stable
   *  reference. If omitted, the component manages its own clock. */
  now?: Date | null
  /** If true, render a tiny phase label badge in the corner (for verification). */
  showLabel?: boolean
}

export function MapStyleInyector({ now, showLabel = false }: MapStyleInyectorProps) {
  const [internalNow, setInternalNow] = useState<Date>(now ?? new Date())

  // Re-evaluate every 60s when no external clock is provided
  useEffect(() => {
    if (now) return // external clock drives re-renders; no interval needed
    const tick = () => setInternalNow(new Date())
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [now])

  // Derived: phase is a pure function of the current time — no state needed.
  const current = now ?? internalNow
  const phase = computePhase(current)
  const style = PHASE_STYLES[phase]

  return (
    <>
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
        style={{
          background: style.background,
          mixBlendMode: style.mixBlendMode as React.CSSProperties['mixBlendMode'],
          opacity: style.opacity,
          transition: 'background 4s ease-in-out, opacity 4s ease-in-out',
          zIndex: 200, // above tile-pane (100), below overlay-pane (400) + marker-pane (9999)
        }}
      />
      {showLabel && (
        <div
          className="fixed pointer-events-none z-[1500] flex items-center gap-1.5 px-2.5 py-1 rounded-full"
          style={{
            bottom: 'max(1rem, env(safe-area-inset-bottom, 1rem))',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(9,9,11,.6)',
            // V6.2 Apple Maps 4000 — backdrop-blur-xl (24px) per spec.
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
            border: '1px solid rgba(255,255,255,.08)',
          }}
        >
          <Sunrise size={10} strokeWidth={1.75} style={{ color: 'rgba(255,255,255,.6)' }} />
          <span
            className="micro-telemetry"
            style={{ color: 'rgba(255,255,255,.6)' }}
          >
            {PHASE_LABEL[phase]} · {current.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      )}
    </>
  )
}

export { computePhase, PHASE_LABEL }
