'use client'

import { useMemo } from 'react'

// ════════════════════════════════════════════════════════════════
// GHOISTRAIL — Horizontal Dot Timeline
// A "memory visual" matrix of dots showing historical positions
// ════════════════════════════════════════════════════════════════
//
// Visual encoding:
//   Position (X)  = time index (left=old → right=new)
//   Opacity       = age (older=transparent → newer=opaque)
//   Size          = speed (faster=larger)
//   Color         = movement state
//   Last dot      = brighter + subtle pulse
//
// ════════════════════════════════════════════════════════════════

// ── TYPES ──

interface GhostrailProps {
  trajectory: Array<{
    lat: number
    lng: number
    observedAt: string | Date
    speedKmh?: number | null
    confidence?: number | null
  }>
  currentMovementState?: string | null
  currentConfidence?: number | null
}

interface Dot {
  x: number
  y: number
  size: number
  color: string
  opacity: number
  isLast: boolean
}

// ── MOVEMENT STATE COLORS (hex for inline styles) ──

const MOVEMENT_COLORS: Record<string, string> = {
  STATIONARY: '#71717a',  // zinc-500
  SLOW: '#fbbf24',       // amber-400
  WALKING: '#34d399',    // emerald-400
  VEHICULAR: '#22d3ee',  // cyan-400
  HIGH_SPEED: '#f87171', // red-400
  ANOMALOUS: '#c084fc',  // purple-400
  UNKNOWN: '#52525b',    // zinc-600
}

// ── SPEED → MOVEMENT STATE ──
// Mirrors signal-pipeline SPEED_THRESHOLDS

function inferMovementState(speedKmh: number | null | undefined): string {
  if (speedKmh == null) return 'UNKNOWN'
  if (speedKmh < 2) return 'STATIONARY'
  if (speedKmh < 5) return 'SLOW'
  if (speedKmh < 15) return 'WALKING'
  if (speedKmh < 120) return 'VEHICULAR'
  return 'HIGH_SPEED'
}

// ── DETERMINISTIC Y OFFSET ──
// Sin-based with prime multipliers so dots don't jump on re-render
// Keeps variation within ±25% of container (60px → ±15px from center)

function deterministicYPercent(index: number): number {
  const offset = Math.sin(index * 2.3) * 12 + Math.sin(index * 5.7) * 6
  return 50 + offset // center=50%, offset range ≈ ±18%
}

// ── COMPONENT ──

export default function Ghostrail({
  trajectory,
  currentMovementState,
  currentConfidence,
}: GhostrailProps) {
  const dots: Dot[] = useMemo(() => {
    if (trajectory.length === 0) return []

    // Cap at 50 visible points (most recent)
    const visible = trajectory.length > 50
      ? trajectory.slice(-50)
      : trajectory

    const total = visible.length

    return visible.map((point, index) => {
      const isLast = index === total - 1

      // ── Opacity: 0.15 (oldest) → 0.9 (newest) ──
      const age = (total - 1 - index) / Math.max(total - 1, 1)
      const opacity = 0.15 + (1 - age) * 0.75

      // ── Size: speed-based ──
      const speed = point.speedKmh ?? 0
      const size = speed < 2 ? 3 : speed < 15 ? 4 : speed < 120 ? 5 : 6

      // ── Color: movement state ──
      const state = isLast && currentMovementState
        ? currentMovementState
        : inferMovementState(point.speedKmh)
      const color = MOVEMENT_COLORS[state] ?? MOVEMENT_COLORS.UNKNOWN

      // ── X: evenly spread 5%–95% ──
      const x = total === 1 ? 50 : (index / (total - 1)) * 90 + 5

      // ── Y: center + deterministic variation ──
      const y = deterministicYPercent(index)

      return { x, y, size, color, opacity, isLast }
    })
  }, [trajectory, currentMovementState, currentConfidence])

  // ── Empty state ──
  if (trajectory.length === 0) {
    return (
      <div
        className="relative w-full h-[60px] flex items-center justify-center overflow-hidden rounded-sm"
        style={{ background: 'rgba(0,0,0,0.6)' }}
      >
        <span className="text-[10px] font-mono tracking-[0.2em] text-zinc-600 select-none">
          SIN HISTORIAL
        </span>
        <div className="absolute top-1/2 left-0 right-0 h-px bg-white/5" />
      </div>
    )
  }

  return (
    <div
      className="relative w-full h-[60px] overflow-hidden rounded-sm"
      style={{ background: 'rgba(0,0,0,0.6)' }}
    >
      {/* Subtle center guide line */}
      <div className="absolute top-1/2 left-0 right-0 h-px bg-white/5 -translate-y-px" />

      {/* Dot matrix */}
      {dots.map((dot, i) => {
        const isPulsing = dot.isLast

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: `${dot.x}%`,
              top: `${dot.y}%`,
              width: dot.size,
              height: dot.size,
              borderRadius: '50%',
              backgroundColor: dot.color,
              opacity: dot.opacity,
              transform: 'translate(-50%, -50%)',
              zIndex: dot.isLast ? 10 : 1,
              boxShadow: isPulsing
                ? `0 0 6px ${dot.color}, 0 0 12px ${dot.color}40`
                : undefined,
              animation: isPulsing
                ? `ghostrail-pulse 2s ease-in-out infinite`
                : undefined,
            }}
          />
        )
      })}

      {/* Pulse keyframes — injected once */}
      <style>{`
        @keyframes ghostrail-pulse {
          0%, 100% {
            filter: brightness(1);
            transform: translate(-50%, -50%) scale(1);
          }
          50% {
            filter: brightness(1.4);
            transform: translate(-50%, -50%) scale(1.3);
          }
        }
      `}</style>
    </div>
  )
}
