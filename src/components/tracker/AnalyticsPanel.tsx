'use client'

import { useMemo, useState, useEffect, type ReactNode } from 'react'
import { Gauge, Timer, MapPin, Activity, Bell, Navigation } from 'lucide-react'
import { analyzePatterns, formatHourRange } from '@/lib/pattern-engine'
import { predictNext, formatProbability } from '@/lib/prediction-engine'
import { requestNotificationPermission, notificationsEnabled } from '@/lib/notifications'

/**
 * AnalyticsPanel (stracker_v5.4_intelligence).
 *
 * Tabbed glass panel rendering two views, both derived from the SAME map
 * data store (ghostrail points + current position + known geofences):
 *
 *  ── Métricas tab (default): the v5.3 deep metrics —
 *     avg_speed (15-min MA), ETA a casa, geofence status.
 *
 *  ── Patrones tab (INTEL_02): minimalist Hotspots list built from the
 *     pattern-engine. Shows TOP_3_SPOTS (k-means over 7d) with their
 *     habitual hours, plus an anomaly badge when the target is at a usual
 *     place at an unusual time.
 *
 * The Bell icon (alert config) reflects notification permission state and
 * re-requests on click. Permission is also auto-requested on dashboard load
 * from TrackerView (see notifications.requestNotificationPermission).
 *
 * Style: V5.5 Deep Black glass (rgba(10,10,10,0.85) + blur(30px) saturate(180%)
 * + border 0.05). V5.6 adds typographic hierarchy — labels are text-xs/font-light/
 * white-50, values are text-2xl/font-semibold/white — and micro-contrast inner
 * cards (bg-white/5 rounded-2xl) that lift data off the panel base for depth.
 */

export interface GhostPoint {
  lat: number
  lng: number
  t?: string
}

interface AnalyticsPanelProps {
  ghostrailPts: GhostPoint[]
  currentLat: number | null
  currentLng: number | null
  currentSpeedKmh: number | null
  home: { lat: number; lng: number; radiusM: number }
  work?: { lat: number; lng: number; radiusM: number }
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function formatEta(minutes: number): string {
  if (!isFinite(minutes) || minutes < 0) return '—'
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${Math.round(minutes)}m`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return `${h}h ${m}m`
}

type Tab = 'metrics' | 'patterns'

export function AnalyticsPanel({
  ghostrailPts,
  currentLat,
  currentLng,
  currentSpeedKmh,
  home,
  work,
}: AnalyticsPanelProps) {
  const [tab, setTab] = useState<Tab>('metrics')
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('unsupported')

  // Track notification permission reactively (Bell icon state).
  useEffect(() => {
    if (typeof Notification === 'undefined') { setPerm('unsupported'); return }
    setPerm(Notification.permission)
  }, [])

  const toggleBell = async () => {
    if (typeof Notification === 'undefined') return
    if (Notification.permission === 'default') {
      const p = await requestNotificationPermission()
      setPerm(p)
    }
  }

  const metrics = useMemo(() => {
    const now = Date.now()
    const windowMs = 15 * 60 * 1000 // 15-minute moving window

    const recent = ghostrailPts
      .filter(p => p.t && now - new Date(p.t).getTime() <= windowMs)
      .sort((a, b) => new Date(a.t!).getTime() - new Date(b.t!).getTime())

    let avgSpeed: number | null = null
    if (recent.length >= 2) {
      let totalDist = 0
      let totalMs = 0
      for (let i = 1; i < recent.length; i++) {
        const d = haversineM(recent[i - 1].lat, recent[i - 1].lng, recent[i].lat, recent[i].lng)
        const dt = new Date(recent[i].t!).getTime() - new Date(recent[i - 1].t!).getTime()
        if (dt > 0) { totalDist += d; totalMs += dt }
      }
      if (totalMs > 0) avgSpeed = (totalDist / 1000) / (totalMs / 3600000) // km/h
    }
    if (avgSpeed == null) avgSpeed = currentSpeedKmh ?? 0

    let distHome: number | null = null
    let inside = false
    if (currentLat != null && currentLng != null) {
      distHome = haversineM(currentLat, currentLng, home.lat, home.lng)
      inside = distHome < home.radiusM
    }

    let etaMin: number | null = null
    if (distHome != null && avgSpeed > 0.5) {
      etaMin = (distHome / 1000) / avgSpeed * 60
    }

    return { avgSpeed, distHome, inside, etaMin }
  }, [ghostrailPts, currentLat, currentLng, currentSpeedKmh, home.lat, home.lng, home.radiusM])

  // INTEL_02: pattern analysis over last 7d. Recomputes on every poll.
  const patterns = useMemo(() => {
    const current = currentLat != null && currentLng != null ? { lat: currentLat, lng: currentLng } : null
    return analyzePatterns(ghostrailPts, current, { home, work })
  }, [ghostrailPts, currentLat, currentLng, home, work])

  // V5.8 PREDICT_ENGINE_MARKOV: First-order Markov chain prediction.
  // Computes P(Destination | Origin, Hour) from the ghostrail transition history.
  // Returns top-3 likely next destinations with probabilities.
  const prediction = useMemo(() => {
    return predictNext(ghostrailPts, currentLat, currentLng, { home, work })
  }, [ghostrailPts, currentLat, currentLng, home, work])

  const glassStyle: React.CSSProperties = {
    background: 'rgba(10,10,10,.85)',
    backdropFilter: 'blur(30px) saturate(180%)',
    WebkitBackdropFilter: 'blur(30px) saturate(180%)',
    border: '1px solid rgba(255,255,255,.05)',
  }

  return (
    <div className="rounded-3xl shadow-2xl overflow-hidden" style={glassStyle}>
      {/* Tab bar: Métricas | Patrones + Bell (alert config) */}
      <div className="flex items-center gap-2 px-3.5 pt-3">
        <TabButton
          active={tab === 'metrics'}
          onClick={() => setTab('metrics')}
          icon={<Gauge size={11} strokeWidth={1.5} />}
          label="Métricas"
        />
        <TabButton
          active={tab === 'patterns'}
          onClick={() => setTab('patterns')}
          icon={<Activity size={11} strokeWidth={1.5} />}
          label="Patrones"
        />
        <button
          onClick={toggleBell}
          aria-label="Configurar alertas"
          className="ml-auto flex items-center justify-center min-h-11 min-w-11 w-11 h-11 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
          style={{
            background: perm === 'granted' ? 'rgba(255,255,255,.1)' : 'rgba(255,255,255,.04)',
            border: `1px solid ${perm === 'granted' ? 'rgba(255,255,255,.2)' : 'rgba(255,255,255,.06)'}`,
            color: perm === 'granted' ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.5)',
            cursor: 'pointer',
          }}
          title={perm === 'granted' ? 'Alertas activas' : perm === 'denied' ? 'Alertas bloqueadas' : 'Activar alertas'}
        >
          <Bell size={11} strokeWidth={1.5} />
        </button>
      </div>

      <div className="p-3.5 pt-3">
        {tab === 'metrics' ? (
          <div className="grid grid-cols-3 gap-2.5 md:gap-3">
            <Metric
              icon={<Gauge size={10} strokeWidth={1.5} />}
              label="VEL MEDIA"
              value={metrics.avgSpeed != null ? metrics.avgSpeed.toFixed(1) : '--'}
              unit="km/h"
              sub="15 min"
            />
            <Metric
              icon={<Timer size={10} strokeWidth={1.5} />}
              label="ETA CASA"
              value={metrics.etaMin != null ? formatEta(metrics.etaMin) : '—'}
              unit=""
              sub={metrics.distHome != null ? `${(metrics.distHome / 1000).toFixed(1)} km` : 's/d'}
            />
            <Metric
              icon={<MapPin size={10} strokeWidth={1.5} />}
              label="GEOFENCE"
              value={metrics.distHome == null ? '—' : metrics.inside ? 'Dentro' : 'Fuera'}
              unit=""
              sub={metrics.distHome != null ? `${Math.round(metrics.distHome)} m` : 's/d'}
              emphasis={metrics.distHome == null ? undefined : metrics.inside ? 'high' : 'low'}
            />
          </div>
        ) : (
          <PatternsView patterns={patterns} prediction={prediction} perm={perm} />
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: ReactNode
  label: string
}) {
  return (
    <button
      onClick={onClick}
      // V6.0: liquid cubic-bezier transition + hover lift + active press.
      className="flex items-center gap-1 px-3 py-1.5 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
      style={{
        background: active ? 'rgba(255,255,255,.08)' : 'transparent',
        border: '1px solid rgba(255,255,255,.04)',
        color: active ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.5)',
        fontSize: 'clamp(9px, 1.2vw, 11px)',
        fontWeight: 500,
        letterSpacing: '0.06em',
        textTransform: 'uppercase' as const,
        cursor: 'pointer',
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function Metric({
  icon,
  label,
  value,
  unit,
  sub,
  emphasis,
}: {
  icon: ReactNode
  label: string
  value: string
  unit: string
  sub: string
  emphasis?: 'high' | 'low'
}) {
  // V5.6 UI_HIERARCHY_01: radical label/value differentiation.
  //   Labels: text-xs (10px in 3-col mobile fit), font-light (300), white/50.
  //   Values: text-2xl (clamp 20→24px), font-semibold (600), pure white.
  // V5.6 UI_MICRO_CONTRAST_02: inner card bg-white/5 + rounded-2xl lifts data
  //   off the panel base, creating depth without opaque backgrounds.
  // V5.6 UI_SPATIAL_PACING_03: p-2.5 padding + gap-1.5 breathing room. Icon
  //   sits in a subtle circular bg to separate from typography.
  const valueColor =
    emphasis === 'high' ? 'rgba(255,255,255,1)' :
    emphasis === 'low' ? 'rgba(255,255,255,.55)' :
    'rgba(255,255,255,.92)'
  return (
    <div
      className="flex flex-col gap-1.5 md:gap-2 min-w-0 rounded-2xl p-2.5 md:p-3 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02]"
      style={{
        background: 'rgba(255,255,255,.05)',
        border: '1px solid rgba(255,255,255,.04)',
      }}
    >
      <div className="flex items-center justify-between gap-1 min-w-0">
        <span
          className="font-light uppercase tracking-wider truncate"
          style={{ color: 'rgba(255,255,255,.5)', fontSize: 'clamp(9px, 1.1vw, 10px)', letterSpacing: '0.06em' }}
        >
          {label}
        </span>
        <div
          className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0"
          style={{
            background: 'rgba(255,255,255,.06)',
            border: '1px solid rgba(255,255,255,.06)',
          }}
        >
          {icon}
        </div>
      </div>
      <div className="flex items-baseline gap-1 min-w-0">
        <span
          className="font-semibold tabular-nums truncate"
          style={{
            color: valueColor,
            fontSize: 'clamp(20px, 5vw, 24px)',
            lineHeight: 1,
            letterSpacing: '-0.02em',
          }}
        >
          {value}
        </span>
        {unit && (
          <span
            className="font-light flex-shrink-0"
            style={{ color: 'rgba(255,255,255,.4)', fontSize: 10 }}
          >
            {unit}
          </span>
        )}
      </div>
      {sub && (
        <span
          className="font-light truncate"
          style={{ color: 'rgba(255,255,255,.4)', fontSize: 9 }}
        >
          {sub}
        </span>
      )}
    </div>
  )
}

function PatternsView({
  patterns,
  prediction,
  perm,
}: {
  patterns: ReturnType<typeof analyzePatterns>
  prediction: ReturnType<typeof predictNext>
  perm: NotificationPermission | 'unsupported'
}) {
  const { spots, anomaly } = patterns
  return (
    <div className="flex flex-col gap-2">
      {/* V5.8 PREDICT_ENGINE_MARKOV: Prediction badge with probability bar.
          Shows the most likely next destination based on the Markov transition
          matrix P(Dest | Origin, Hour). Apple blue accent distinguishes it
          from the monochrome hotspot cards below. */}
      {prediction.available && prediction.predictions.length > 0 ? (
        <PredictionBadge prediction={prediction} />
      ) : null}

      {/* Anomaly badge (if any) — V5.5 monochrome white, V5.6 inner card */}
      {anomaly.detected ? (
        <div
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl"
          style={{
            background: 'rgba(255,255,255,.06)',
            border: '1px solid rgba(255,255,255,.12)',
          }}
        >
          <div
            className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0"
            style={{
              background: 'rgba(255,255,255,.08)',
              border: '1px solid rgba(255,255,255,.08)',
            }}
          >
            <Activity size={10} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.95)' }} />
          </div>
          <span className="font-semibold uppercase tracking-wider truncate" style={{ color: 'rgba(255,255,255,.95)', fontSize: 10, letterSpacing: '0.06em' }}>
            Anomalía
          </span>
          <span className="font-light truncate" style={{ color: 'rgba(255,255,255,.6)', fontSize: 10 }}>
            {anomaly.reason}
          </span>
        </div>
      ) : null}

      {/* Hotspots list — V5.6 micro-contrast cards + typography hierarchy */}
      {spots.length === 0 ? (
        <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl" style={{ background: 'rgba(255,255,255,.03)' }}>
          <div
            className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0"
            style={{
              background: 'rgba(255,255,255,.05)',
              border: '1px solid rgba(255,255,255,.05)',
            }}
          >
            <Activity size={10} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.35)' }} />
          </div>
          <span className="font-light" style={{ color: 'rgba(255,255,255,.45)', fontSize: 10 }}>
            Sin datos suficientes (necesita visitas ≥60 min en 7d)
          </span>
        </div>
      ) : (
        spots.map((s, i) => (
          <div key={`spot-${i}`} className="flex items-center gap-2 px-2.5 py-2 rounded-xl" style={{ background: 'rgba(255,255,255,.05)', border: '1px solid rgba(255,255,255,.04)' }}>
            <div
              className="flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0"
              style={{
                background: 'rgba(255,255,255,.06)',
                border: '1px solid rgba(255,255,255,.06)',
              }}
            >
              <MapPin size={11} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.7)' }} />
            </div>
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
              <div className="flex items-baseline gap-1.5">
                <span className="font-semibold truncate" style={{ color: 'rgba(255,255,255,.95)', fontSize: 12 }}>
                  {s.label}
                </span>
                <span className="font-light flex-shrink-0 tabular-nums" style={{ color: 'rgba(255,255,255,.45)', fontSize: 10 }}>
                  {Math.round(s.totalDwellMin / 60)}h {s.totalDwellMin % 60}m
                </span>
              </div>
              <span className="font-light truncate" style={{ color: 'rgba(255,255,255,.45)', fontSize: 10 }}>
                {formatHourRange(s.habitualHours) || 'horario variable'}
              </span>
            </div>
          </div>
        ))
      )}

      {/* V5.8: Prediction unavailable reason (subtle, only when at a hotspot but no transitions yet) */}
      {!prediction.available && prediction.currentSpot && prediction.reason ? (
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl" style={{ background: 'rgba(10,132,255,.04)', border: '1px solid rgba(10,132,255,.08)' }}>
          <div
            className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0"
            style={{ background: 'rgba(10,132,255,.08)', border: '1px solid rgba(10,132,255,.12)' }}
          >
            <Navigation size={10} strokeWidth={1.5} style={{ color: 'rgba(10,132,255,.6)' }} />
          </div>
          <span className="font-light truncate" style={{ color: 'rgba(10,132,255,.5)', fontSize: 9 }}>
            {prediction.reason}
          </span>
        </div>
      ) : null}

      {/* Alert permission hint */}
      {perm !== 'granted' && perm !== 'unsupported' && (
        <div className="flex items-center gap-1.5 px-2 pt-0.5">
          <Bell size={9} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.3)' }} />
          <span className="font-light" style={{ color: 'rgba(255,255,255,.35)', fontSize: 9 }}>
            Tocá la campana para activar alertas reactivas
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * V5.8 PredictionBadge — Renders the Markov chain prediction with a
 * probability bar. Uses Apple blue (#0a84ff) as the accent color to
 * distinguish the prediction (forward-looking intelligence) from the
 * retrospective hotspot data (monochrome white).
 */
function PredictionBadge({ prediction }: { prediction: ReturnType<typeof predictNext> }) {
  const top = prediction.predictions[0]
  if (!top) return null
  const pct = Math.round(top.probability * 100)

  return (
    <div
      className="flex flex-col gap-1.5 px-2.5 py-2 rounded-xl"
      style={{
        background: 'rgba(10,132,255,.06)',
        border: '1px solid rgba(10,132,255,.15)',
      }}
    >
      <div className="flex items-center gap-2">
        <div
          className="flex items-center justify-center w-5 h-5 rounded-full flex-shrink-0"
          style={{
            background: 'rgba(10,132,255,.12)',
            border: '1px solid rgba(10,132,255,.2)',
          }}
        >
          <Navigation size={10} strokeWidth={1.5} style={{ color: 'rgba(10,132,255,.95)' }} />
        </div>
        <span
          className="font-light uppercase tracking-wider"
          style={{ color: 'rgba(10,132,255,.7)', fontSize: 9, letterSpacing: '0.08em' }}
        >
          Predicción
        </span>
        <span
          className="font-semibold ml-auto tabular-nums"
          style={{ color: 'rgba(10,132,255,.95)', fontSize: 12 }}
        >
          {formatProbability(top.probability)}
        </span>
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="font-light truncate" style={{ color: 'rgba(255,255,255,.5)', fontSize: 9 }}>
          Probable destino
        </span>
        <span className="font-semibold truncate" style={{ color: 'rgba(255,255,255,.95)', fontSize: 13 }}>
          {top.label}
        </span>
      </div>
      {/* Probability bar — Apple blue gradient */}
      <div
        className="w-full rounded-full overflow-hidden"
        style={{
          height: 3,
          background: 'rgba(255,255,255,.06)',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: 'linear-gradient(90deg, rgba(10,132,255,.4), rgba(10,132,255,.95))',
            borderRadius: 'inherit',
            // V6.0: liquid cubic-bezier per Apple Maps 4000 spec.
            transition: 'width 600ms cubic-bezier(0.2, 0.8, 0.2, 1)',
          }}
        />
      </div>
      {/* Secondary predictions (if any) — small text */}
      {prediction.predictions.length > 1 ? (
        <div className="flex items-center gap-2 mt-0.5">
          {prediction.predictions.slice(1).map((p, i) => (
            <div key={`pred-${i}`} className="flex items-center gap-1">
              <span className="font-light truncate" style={{ color: 'rgba(255,255,255,.4)', fontSize: 9 }}>
                {p.label}
              </span>
              <span className="font-light tabular-nums" style={{ color: 'rgba(10,132,255,.5)', fontSize: 9 }}>
                {formatProbability(p.probability)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
