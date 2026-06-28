'use client'

/**
 * SpeedGauge — MC_8_04 (stracker_v8_hyper_premium)
 *
 * Radial glass speedometer (Apple Watch ring style). A single SVG ring with
 * stroke-dasharray fill that maps speed → ring progress, and a color gradient
 * that shifts fluidly across speed bands:
 *
 *   0–20 km/h   → Azul cyan   (#5ac8fa / #0a84ff)
 *  20–60 km/h   → Verde esmeralda (#30d158)
 *  60–80 km/h   → Naranja     (#ff9f0a)
 *  80+ km/h     → Rojo fuego  (#ff453a)
 *
 * Glassmorphism: dark translucent disc + backdrop-blur. Center renders the
 * numeric speed (tabular-nums) + "km/h" micro-telemetry label. Designed to
 * sit inside the TrackerSheet half/full snap as an at-a-glance kinetic read.
 *
 * Per design_system_v8.typography.telemetry_lock: tabular-nums on all
 * numeric renders to prevent visual jumps as digits change.
 */

interface SpeedGaugeProps {
  speedKmh: number | null
  /** Pixel size of the square gauge. Default 120. */
  size?: number
  /** Max speed for ring fill normalization. Default 120 km/h. */
  maxSpeed?: number
}

// V5.5 Deep Black: speed ring is monochrome white. Intensity (opacity +
// glow) scales with speed so the read remains kinetic without introducing
// color. The only colored element in the whole app is the Apple-blue
// location dot on the map.
function speedVisual(kmh: number): { stroke: string; glow: string; label: string; opacity: number } {
  if (kmh >= 80) return { stroke: '#ffffff', glow: 'rgba(255,255,255,0.5)', label: 'RÁPIDO', opacity: 1 }
  if (kmh >= 60) return { stroke: '#ffffff', glow: 'rgba(255,255,255,0.4)', label: 'VIVO', opacity: 0.92 }
  if (kmh >= 20) return { stroke: '#ffffff', glow: 'rgba(255,255,255,0.3)', label: 'ÁGIL', opacity: 0.8 }
  return { stroke: '#ffffff', glow: 'rgba(255,255,255,0.2)', label: 'LENTO', opacity: 0.55 }
}

export function SpeedGauge({ speedKmh, size = 120, maxSpeed = 120 }: SpeedGaugeProps) {
  const speed = speedKmh ?? 0
  const pct = Math.max(0, Math.min(1, speed / maxSpeed))

  // Ring geometry — leave room for the stroke width.
  const stroke = Math.max(6, Math.round(size * 0.07))
  const radius = (size - stroke) / 2 - 2
  const cx = size / 2
  const cy = size / 2
  // SVG arc geometry: circumference = 2πr. We fill 270° of the circle
  // (leaving a 90° gap at the bottom for the Apple Watch "open ring" look).
  const ARC_FRACTION = 0.75
  const circumference = 2 * Math.PI * radius
  const dashLen = circumference * ARC_FRACTION
  const filledLen = dashLen * pct

  const { stroke: ringColor, glow, label, opacity: ringOpacity } = speedVisual(speed)

  // Rotate the ring so the gap sits at the bottom (270° → start at 135°)
  const ringRotation = 135

  // Numeric display
  const displaySpeed = speedKmh == null ? '--' : Math.round(speed * 10) / 10
  const isStopped = speedKmh != null && speed < 0.5

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size, flexShrink: 0 }}
    >
      {/* Glass disc backdrop — V5.5 deep black, V6.0 shadow-2xl elevation */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: 'rgba(10,10,10,.85)',
          backdropFilter: 'blur(30px) saturate(180%)',
          WebkitBackdropFilter: 'blur(30px) saturate(180%)',
          border: '1px solid rgba(255,255,255,.05)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,.04), 0 8px 32px rgba(0,0,0,.5), 0 24px 64px rgba(0,0,0,.45)',
        }}
      />
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: `rotate(${ringRotation}deg)`, overflow: 'visible' }}
      >
        <defs>
          <linearGradient id="speed-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={ringColor} stopOpacity="0.85" />
            <stop offset="100%" stopColor={ringColor} stopOpacity="1" />
          </linearGradient>
        </defs>
        {/* Track (unfilled arc) — V5.5 monochrome faint */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,.05)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${dashLen} ${circumference}`}
        />
        {/* Filled arc — the actual speed (monochrome white, opacity by band) */}
        <circle
          cx={cx}
          cy={cy}
          r={radius}
          fill="none"
          stroke="url(#speed-ring-grad)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${filledLen} ${circumference}`}
          style={{
            // V6.0: liquid cubic-bezier transition per Apple Maps 4000 spec.
            transition: 'stroke-dasharray 600ms cubic-bezier(0.2, 0.8, 0.2, 1), stroke 400ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 400ms ease',
            filter: `drop-shadow(0 0 6px ${glow})`,
            opacity: ringOpacity,
          }}
        />
      </svg>
      {/* Center numeric readout — counter-rotate so text stays upright */}
      <div
        className="absolute inset-0 flex flex-col items-center justify-center"
        style={{ transform: `rotate(${-ringRotation}deg)` }}
      >
        <span
          className="font-bold tabular-nums"
          style={{
            color: isStopped ? 'rgba(255,255,255,.35)' : 'rgba(255,255,255,.95)',
            fontSize: Math.round(size * 0.26),
            lineHeight: 1,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {displaySpeed}
        </span>
        <span
          className="micro-telemetry"
          style={{ marginTop: 2, color: isStopped ? 'rgba(255,255,255,.3)' : 'rgba(255,255,255,.5)' }}
        >
          {isStopped ? 'STOP' : 'km/h'}
        </span>
        {!isStopped && speedKmh != null && (
          <span
            className="font-bold uppercase"
            style={{
              color: 'rgba(255,255,255,.6)',
              fontSize: Math.round(size * 0.085),
              marginTop: 1,
              letterSpacing: '0.08em',
              opacity: 0.7,
            }}
          >
            {label}
          </span>
        )}
      </div>
    </div>
  )
}
