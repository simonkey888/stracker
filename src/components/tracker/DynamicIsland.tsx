'use client'

import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Footprints, Car, Bus, Moon, PersonStanding,
  Info, TriangleAlert, OctagonX,
} from 'lucide-react'
import type { ComponentType } from 'react'

// FIX_3 (stracker_hotfix_ui_v8.1): token -> lucide-react icon maps.
// The movementIcon prop now receives a token string ('walk'|'car'|'bus'|
// 'sleep'|'still') which we resolve to a vector icon here. Alert glyphs
// (info / warning / critical) are likewise replaced with lucide icons.
type LucideCmp = typeof Car
const MOVEMENT_ICON: Record<string, LucideCmp> = {
  walk: Footprints,
  car: Car,
  bus: Bus,
  sleep: Moon,
  still: PersonStanding,
}
function resolveMovementIcon(token: string): LucideCmp {
  return MOVEMENT_ICON[token] ?? PersonStanding
}

/**
 * DynamicIsland — MC_8_03 (stracker_v8_hyper_premium)
 *
 * iOS Dynamic Island HUD. Replaces both the StateChip (top-center pill) and
 * the standalone Toast system. A single floating black pill that:
 *
 *   - COMPACT state: shows live telemetry (movement • place • zone) with a
 *     pulsing LED driven by spoof level + a heartbeat pulse synced to every
 *     fresh payload arrival (AT_2).
 *   - EXPANDED state: elastically grows to surface a critical alert (spoof
 *     jump, zone change, arrival). Auto-collapses after 6s.
 *
 * Design tokens (design_system_v8.motion_curves):
 *   - dynamic_island_snap: spring(mass 0.5, stiffness 400, damping 30)
 *   - apple_spring: cubic-bezier(0.32, 0.72, 0, 1)
 *
 * The pill sits at top-center, pointer-events-none (alerts are informational).
 * maxWidth is clamped so it never collides with FloatingControls (top-right)
 * or the desktop left panel.
 */

export type IslandAlertKind = 'info' | 'warning' | 'critical'

export interface IslandAlert {
  kind: IslandAlertKind
  msg: string
  /** Optional secondary line (e.g. signal detail). */
  detail?: string
}

type SpoofLevel = 'trusted' | 'warning' | 'suspicious' | 'spoof_detected'

interface DynamicIslandProps {
  movementIcon: string
  movementLabel: string
  placeLabel: string
  zoneLabel?: string
  zoneColor?: string
  spoofColor: string
  spoofLevel: SpoofLevel
  isMobile: boolean
  /** When non-null, the island expands to show this alert. */
  alert: IslandAlert | null
  /** Monotonic timestamp updated on every fresh payload arrival — drives the
   *  AT_2 heartbeat pulse on the LED (two quick beats + pause). */
  heartbeatTs: number
  /** Called when the alert auto-dismisses or user dismisses it. */
  onAlertDismiss?: () => void
}

// design_system_v8.motion_curves.dynamic_island_snap
const ISLAND_SPRING = { type: 'spring' as const, stiffness: 400, damping: 30, mass: 0.5 }
// Slightly softer for width growth (feels less jittery on text reflow)
const WIDTH_SPRING = { type: 'spring' as const, stiffness: 320, damping: 32, mass: 0.5 }

const ALERT_AUTO_DISMISS_MS = 6000

// V5.5 Deep Black: alert LEDs are monochrome white. Severity is conveyed
// by pulse rate (critical pulses fastest), not by color. The glow intensity
// scales with severity so the eye still picks up urgency.
const ALERT_VISUALS: Record<IslandAlertKind, { led: string; glow: string; icon: ComponentType<{ size?: number; strokeWidth?: number }> }> = {
  info: { led: 'rgba(255,255,255,0.85)', glow: 'rgba(255,255,255,0.2)', icon: Info },
  warning: { led: 'rgba(255,255,255,0.95)', glow: 'rgba(255,255,255,0.3)', icon: TriangleAlert },
  critical: { led: '#ffffff', glow: 'rgba(255,255,255,0.45)', icon: OctagonX },
}

export function DynamicIsland({
  movementIcon,
  movementLabel,
  placeLabel,
  zoneLabel,
  zoneColor,
  spoofColor,
  spoofLevel,
  isMobile,
  alert,
  heartbeatTs,
  onAlertDismiss,
}: DynamicIslandProps) {
  const hasAlert = !!alert
  const placeText = placeLabel || 'Sin señal'
  const zoneText = zoneLabel ? `• ${zoneLabel}` : ''

  // LED pulse animation by spoof severity (reuses v7 keyframes)
  const ledAnimation =
    spoofLevel === 'spoof_detected'
      ? 'led-pulse-critical 1s ease-in-out infinite'
      : spoofLevel === 'suspicious' || spoofLevel === 'warning'
        ? 'led-pulse-warn 1.6s ease-in-out infinite'
        : 'led-pulse-calm 2.8s ease-in-out infinite'

  // AT_2: heartbeat re-trigger. We use heartbeatTs directly as the React
  // `key` on the heartbeat overlay span — each new payload bumps the key,
  // forcing a remount that replays the @keyframes heartbeat-ring animation.
  // No state needed (derived from the prop).

  // Auto-dismiss alert after timeout
  useEffect(() => {
    if (!hasAlert) return
    const t = setTimeout(() => onAlertDismiss?.(), ALERT_AUTO_DISMISS_MS)
    return () => clearTimeout(t)
  }, [hasAlert, alert, onAlertDismiss])

  const alertVisual = alert ? ALERT_VISUALS[alert.kind] : null

  return (
    <div
      className="absolute z-[9999] pointer-events-none flex justify-center"
      style={{
        // V6.0 Apple Maps 4000 — expansive insets: 16px mobile, 32px desktop.
        top: isMobile
          ? 'max(1rem, env(safe-area-inset-top, 1rem))'
          : 'max(2rem, env(safe-area-inset-top, 2rem))',
        left: '50%',
        transform: 'translateX(-50%)',
        // RA30: `absolute` within the map-area flex sibling. maxWidth is now
        // relative to the map area (not viewport). Leave room for FloatingControls
        // (top-right, 44px + 32px margin) + breathing room on each side.
        maxWidth: isMobile ? 'calc(100% - 130px)' : 'calc(100% - 110px)',
      }}
    >
      <motion.div
        layout
        transition={ISLAND_SPRING}
        className="pointer-events-auto flex items-center gap-2 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
        style={{
          background: 'rgba(10,10,10,.85)',
          backdropFilter: 'blur(30px) saturate(180%)',
          WebkitBackdropFilter: 'blur(30px) saturate(180%)',
          border: hasAlert
            ? `1px solid ${alertVisual?.glow || 'rgba(255,255,255,.1)'}`
            : '1px solid rgba(255,255,255,.05)',
          // V6.0: shadow-2xl equivalent — deeper, softer drop for the floating pill.
          boxShadow: hasAlert
            ? `0 8px 32px ${alertVisual?.glow}, 0 0 0 1px rgba(0,0,0,.4), 0 24px 64px rgba(0,0,0,.6)`
            : '0 8px 32px rgba(0,0,0,.5), 0 24px 64px rgba(0,0,0,.45)',
          padding: hasAlert ? '10px 16px' : '9px 14px',
        }}
        onClick={() => hasAlert && onAlertDismiss?.()}
      >
        {/* ── LED: spoof-state pulse + AT_2 heartbeat overlay ── */}
        <span style={{ position: 'relative', width: 9, height: 9, flexShrink: 0 }}>
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              background: hasAlert ? alertVisual?.led : spoofColor,
              boxShadow: `0 0 8px ${hasAlert ? alertVisual?.led : spoofColor}, 0 0 16px ${hasAlert ? alertVisual?.glow : spoofColor}80`,
              animation: hasAlert ? 'led-pulse-critical 0.8s ease-in-out infinite' : ledAnimation,
            }}
          />
          {/* AT_2 heartbeat overlay — replays on every fresh payload */}
          {!hasAlert && heartbeatTs > 0 && (
            <span
              key={`beat-${heartbeatTs}`}
              style={{
                position: 'absolute',
                inset: -3,
                borderRadius: '50%',
                border: `1.5px solid rgba(255,255,255,.6)`,
                animation: 'heartbeat-ring 1.1s ease-out 1',
                pointerEvents: 'none',
              }}
            />
          )}
        </span>

        <AnimatePresence mode="wait" initial={false}>
          {hasAlert ? (
            // ── EXPANDED ALERT STATE ──
            <motion.div
              key="alert"
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              transition={WIDTH_SPRING}
              className="flex items-center gap-2 overflow-hidden whitespace-nowrap"
            >
              {(() => { const AIcon = alertVisual?.icon; return AIcon ? <AIcon size={13} strokeWidth={1.5} style={{ color: alertVisual?.led }} /> : null })()}
              <span
                style={{
                  color: alertVisual?.led,
                  fontSize: isMobile ? 12 : 13,
                  fontWeight: 700,
                  letterSpacing: '-0.01em',
                }}
              >
                {alert?.msg}
              </span>
              {alert?.detail && (
                <span style={{ color: 'rgba(255,255,255,.5)', fontSize: isMobile ? 10 : 11 }}>
                  {alert.detail}
                </span>
              )}
            </motion.div>
          ) : (
            // ── COMPACT TELEMETRY STATE ──
            <motion.div
              key="compact"
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              transition={WIDTH_SPRING}
              className="flex items-center gap-2 overflow-hidden whitespace-nowrap"
            >
              {(() => { const MIcon = resolveMovementIcon(movementIcon); return <MIcon size={13} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.85)' }} /> })()}
              <span
                className="font-semibold tabular-nums"
                style={{
                  color: 'rgba(255,255,255,.9)',
                  fontSize: isMobile ? 12 : 13,
                  letterSpacing: '-0.01em',
                  maxWidth: isMobile ? 120 : 180,
                }}
              >
                {movementLabel}
              </span>
              <span style={{ color: 'rgba(255,255,255,.2)', fontSize: 13 }}>|</span>
              <span
                className="truncate tabular-nums"
                style={{
                  color: 'rgba(255,255,255,.55)',
                  fontSize: isMobile ? 11 : 12,
                  fontWeight: 500,
                }}
              >
                {placeText} {zoneText && <span style={{ opacity: 0.6 }}>{zoneText}</span>}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  )
}
