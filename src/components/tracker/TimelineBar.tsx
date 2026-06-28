'use client'

import { useMemo } from 'react'
import { Timer, StepBack, Play, Radio } from 'lucide-react'

/**
 * TimelineBar — stracker_v5.7_navigation (NAV_01_PATH_ENGINE / ui_integration)
 *
 * Replaces the old floating glass-pill time scrubber with a TimelineBar
 * integrated BENEATH the map. Consistent Deep Black glassmorphism.
 *
 * Features:
 *   - 24h track (T-24h → T-0) with a range slider controlling the point index
 *   - "Tiempo Real" vs "Histórico" mode indicator (visual badge)
 *   - Live timestamp readout of the currently selected point
 *   - LIVE button to return to real-time mode
 *
 * The slider's `value` maps to the index in the ghostrail points array.
 * min=0 (oldest, T-24h), max=N-1 (newest, T-0/live). When the user drags,
 * `onScrub` is called with the index → TrackerView filters the rendered
 * points and moves the marker to the scrubbed position.
 */
interface TimelineBarProps {
  /** Ghostrail points (chronological, oldest first). Used for count + timestamps. */
  points: { lat: number; lng: number; t?: string }[]
  /** Current scrub index, or null when in live mode. */
  scrubIndex: number | null
  /** Whether the user is actively scrubbing (historical mode). */
  scrubbing: boolean
  /** Called when the slider value changes. */
  onScrub: (index: number) => void
  /** Called when the user clicks LIVE to return to real-time. */
  onLive: () => void
}

export function TimelineBar({
  points,
  scrubIndex,
  scrubbing,
  onScrub,
  onLive,
}: TimelineBarProps) {
  const max = Math.max(0, points.length - 1)
  const value = scrubIndex ?? max

  // The currently-selected point (for timestamp display)
  const selectedPoint = useMemo(() => {
    if (points.length === 0) return null
    const idx = Math.max(0, Math.min(value, points.length - 1))
    return points[idx]
  }, [points, value])

  // Format the selected point's timestamp
  const timeLabel = useMemo(() => {
    if (!selectedPoint?.t) return '—'
    try {
      const d = new Date(selectedPoint.t)
      return d.toLocaleString('es-AR', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: '2-digit',
      })
    } catch {
      return '—'
    }
  }, [selectedPoint])

  // Compute the time span of the track (T-24h to T-0)
  const trackSpan = useMemo(() => {
    if (points.length < 2) return null
    const first = points[0].t ? new Date(points[0].t!).getTime() : null
    const last = points[points.length - 1].t
      ? new Date(points[points.length - 1].t!).getTime()
      : null
    if (!first || !last) return null
    const spanMin = Math.round((last - first) / 60000)
    if (spanMin < 60) return `${spanMin}min`
    const h = Math.floor(spanMin / 60)
    const m = spanMin % 60
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }, [points])

  // Percentage for the progress fill
  const fillPct = max > 0 ? (value / max) * 100 : 100

  return (
    <div
      className="rounded-3xl shadow-2xl"
      style={{
        background: 'rgba(10,10,10,.85)',
        backdropFilter: 'blur(30px) saturate(180%)',
        WebkitBackdropFilter: 'blur(30px) saturate(180%)',
        border: '1px solid rgba(255,255,255,.05)',
        // V6.0 Apple Maps 4000 — expansive padding for breathing room.
        padding: '14px 18px 16px',
        boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 24px 64px rgba(0,0,0,.45)',
      }}
    >
      {/* Header row: mode indicator + timestamp + LIVE button */}
      <div className="flex items-center gap-3 mb-3">
        {/* Mode indicator: Tiempo Real (live) vs Histórico (scrubbing) */}
        <div
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
          style={{
            background: scrubbing ? 'rgba(255,255,255,.08)' : 'rgba(10,132,255,.12)',
            border: `1px solid ${scrubbing ? 'rgba(255,255,255,.15)' : 'rgba(10,132,255,.3)'}`,
          }}
        >
          {scrubbing ? (
            <StepBack size={10} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.9)' }} />
          ) : (
            <Radio size={10} strokeWidth={1.5} style={{ color: 'rgba(10,132,255,.95)' }} />
          )}
          <span
            className="font-semibold uppercase tracking-wider"
            style={{
              fontSize: 9,
              letterSpacing: '0.08em',
              color: scrubbing ? 'rgba(255,255,255,.9)' : 'rgba(10,132,255,.95)',
            }}
          >
            {scrubbing ? 'Histórico' : 'Tiempo Real'}
          </span>
          {/* Live pulse dot */}
          {!scrubbing && (
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: 'rgba(10,132,255,.95)',
                boxShadow: '0 0 6px rgba(10,132,255,.6)',
                animation: 'livePulse 1.8s ease-in-out infinite',
              }}
            />
          )}
        </div>

        {/* Timeline label */}
        <div className="flex items-center gap-1">
          <Timer size={10} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.5)' }} />
          <span
            className="font-light uppercase tracking-wider"
            style={{ fontSize: 9, letterSpacing: '0.06em', color: 'rgba(255,255,255,.5)' }}
          >
            Timeline 24h
          </span>
        </div>

        {/* Timestamp readout (right-aligned) */}
        <span
          className="font-light tabular-nums ml-auto"
          style={{ fontSize: 10, color: 'rgba(255,255,255,.6)' }}
        >
          {timeLabel}
        </span>

        {/* LIVE button (only when scrubbing) */}
        {scrubbing && (
          <button
            onClick={onLive}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: 'rgba(10,132,255,.12)',
              border: '1px solid rgba(10,132,255,.3)',
              color: 'rgba(10,132,255,.95)',
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: '0.08em',
              cursor: 'pointer',
            }}
          >
            <Play size={9} fill="currentColor" />
            <span className="uppercase">Live</span>
          </button>
        )}
      </div>

      {/* Track + slider */}
      <div className="relative" style={{ height: 20 }}>
        {/* Track background (24h gradient line) */}
        <div
          className="absolute left-0 right-0"
          style={{
            top: '50%',
            transform: 'translateY(-50%)',
            height: 3,
            borderRadius: 2,
            background:
              'linear-gradient(to right, rgba(255,255,255,.08) 0%, rgba(10,132,255,.15) 100%)',
          }}
        />
        {/* Filled portion (up to current scrub position) */}
        <div
          className="absolute left-0"
          style={{
            top: '50%',
            transform: 'translateY(-50%)',
            height: 3,
            borderRadius: 2,
            width: `${fillPct}%`,
            background: scrubbing
              ? 'rgba(255,255,255,.5)'
              : 'rgba(10,132,255,.6)',
            transition: 'width 150ms ease-out',
          }}
        />
        {/* Endpoints labels */}
        <span
          className="absolute font-light tabular-nums"
          style={{
            left: 0,
            top: -1,
            fontSize: 8,
            color: 'rgba(255,255,255,.35)',
            transform: 'translateY(-100%)',
          }}
        >
          T-24h
        </span>
        <span
          className="absolute font-light tabular-nums"
          style={{
            right: 0,
            top: -1,
            fontSize: 8,
            color: scrubbing ? 'rgba(255,255,255,.35)' : 'rgba(10,132,255,.7)',
            transform: 'translateY(-100%)',
          }}
        >
          T-0
        </span>
        {/* Track span (bottom-right) */}
        {trackSpan && (
          <span
            className="absolute font-light tabular-nums"
            style={{
              right: 0,
              bottom: -1,
              fontSize: 8,
              color: 'rgba(255,255,255,.3)',
              transform: 'translateY(100%)',
            }}
          >
            {trackSpan} · {points.length} pts
          </span>
        )}
        {/* Range input (transparent, overlays the track) */}
        <input
          type="range"
          min={0}
          max={max}
          value={value}
          onChange={(e) => onScrub(parseInt(e.target.value, 10))}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            width: '100%',
            height: '100%',
            margin: 0,
            appearance: 'none',
            WebkitAppearance: 'none',
            background: 'transparent',
            outline: 'none',
            cursor: 'pointer',
          }}
        />
      </div>

      {/* Slider thumb styles */}
      <style>{`
        .timeline-bar input[type=range]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 16px; height: 16px;
          border-radius: 50%;
          background: ${scrubbing ? 'rgba(255,255,255,0.9)' : 'rgba(10,132,255,0.95)'};
          border: 2px solid rgba(255,255,255,0.9);
          box-shadow: 0 0 10px ${scrubbing ? 'rgba(255,255,255,0.3)' : 'rgba(10,132,255,0.5)'};
          cursor: pointer;
          transition: all 150ms ease;
        }
        .timeline-bar input[type=range]::-webkit-slider-thumb:hover {
          transform: scale(1.15);
        }
        .timeline-bar input[type=range]::-moz-range-thumb {
          width: 16px; height: 16px;
          border-radius: 50%;
          background: ${scrubbing ? 'rgba(255,255,255,0.9)' : 'rgba(10,132,255,0.95)'};
          border: 2px solid rgba(255,255,255,0.9);
          box-shadow: 0 0 10px ${scrubbing ? 'rgba(255,255,255,0.3)' : 'rgba(10,132,255,0.5)'};
          cursor: pointer;
        }
        @keyframes livePulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.5; transform: scale(0.85); }
        }
      `}</style>
    </div>
  )
}
