'use client'

import { Layers, Compass, Eye, EyeOff } from 'lucide-react'

/**
 * FloatingControls — T3 Premium (stracker_v7_ui_evolution)
 *
 * Apple Maps / Uber style: 3 minimal CIRCULAR glass buttons, vertically
 * stacked, top-right. Completely isolated from the bottom panel hierarchy.
 *
 * Buttons (per directive controles_flotantes_mapa):
 *   - toggle_satellite — Lucide `Layers`  ("Capas — Satélite")
 *   - recenter_pin     — Lucide `Compass` ("Centrar en pin")
 *   - toggle_ghostrail — Lucide `Eye`/`EyeOff` ("GhostRail")
 *
 * Visuals: 44px rounded-full glass, bg-[#0a0a0a]/85 backdrop-blur,
 * border-white/5, shadow-2xl elevation, liquid cubic-bezier transitions.
 *
 * RA30 DESKTOP_LAYOUT_DOCKING: `position: absolute` (was `fixed`) — positioned
 * relative to the map-area flex sibling, not the viewport. On desktop the map
 * area is the right portion (flex-1), so `right-4 md:right-8` is 16/32px from
 * the map area's right edge. The controls stay clear of the LEFT-docked sheet.
 */
interface FloatingControlsProps {
  isSatellite: boolean
  onToggleSatellite: () => void
  onCenter: () => void
  ghostVisible: boolean
  onToggleGhost: () => void
}

function GlassButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      // V6.0 Apple Maps 4000 — 44px min touch target, shadow-2xl elevation,
      // liquid cubic-bezier transitions, hover lift + active press.
      className="flex items-center justify-center min-h-11 min-w-11 h-11 w-11 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
      style={{
        background: active ? 'rgba(255,255,255,.08)' : 'rgba(10,10,10,.85)',
        backdropFilter: 'blur(30px) saturate(180%)',
        WebkitBackdropFilter: 'blur(30px) saturate(180%)',
        border: active ? '1px solid rgba(255,255,255,.15)' : '1px solid rgba(255,255,255,.05)',
        boxShadow: active
          ? '0 8px 32px rgba(255,255,255,.06), 0 0 0 1px rgba(255,255,255,.04), 0 12px 32px rgba(0,0,0,.5)'
          : '0 8px 32px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.4)',
        color: active ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.7)',
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

export function FloatingControls({
  isSatellite,
  onToggleSatellite,
  onCenter,
  ghostVisible,
  onToggleGhost,
}: FloatingControlsProps) {
  return (
    <div
      className="absolute z-30 top-24 md:top-32 right-4 md:right-8 flex flex-col gap-3 md:gap-4 pointer-events-auto"
    >
      <GlassButton active={isSatellite} title="Capas — Satélite" onClick={onToggleSatellite}>
        <Layers size={18} strokeWidth={1.5} />
      </GlassButton>
      <GlassButton title="Centrar en pin" onClick={onCenter}>
        <Compass size={18} strokeWidth={1.5} />
      </GlassButton>
      <GlassButton active={ghostVisible} title="GhostRail" onClick={onToggleGhost}>
        {ghostVisible ? <Eye size={18} strokeWidth={1.5} /> : <EyeOff size={18} strokeWidth={1.5} />}
      </GlassButton>
    </div>
  )
}
