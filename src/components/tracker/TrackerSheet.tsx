'use client'

import { useState, useEffect, useRef, type ReactNode } from 'react'
import { motion } from 'framer-motion'

/**
 * TrackerSheet — T3 Premium (stracker_v7_ui_evolution)
 *
 * Apple Maps / Uber style bottom sheet with pixel-precise snap points.
 *
 * Mobile (<768px): TRUE bottom sheet.
 *   - Snap points: CLOSED (38px — drag handle + status pill only)
 *                  HALF  (260px — main modules + cookies + quick telemetry)
 *                  FULL  (82vh — accordion expanded, forensic JSON, diagnostics)
 *   - Drag handle at top, swipe up/down to snap.
 *   - Spring physics (framer-motion): stiffness 350, damping 30, mass 0.7
 *   - Backdrop blur on map intensifies as sheet expands (T5 magic #1).
 *
 * Desktop (>=768px): LEFT flex-dock panel (w-96).
 *   - position: relative — a flex sibling of the map area (NOT a floating overlay).
 *   - The root layout (TrackerView) is `flex flex-row-reverse` on desktop, so
 *     the sheet takes 384px on the LEFT and the map takes flex-1 on the RIGHT.
 *   - Always "open" — no snap points.
 *   - Pin never hidden: the map's visible area is naturally clear of the sheet
 *     (no camera-offset hack needed — PIN_OFFSET_X is now 0).
 *
 * Invariants:
 *   - Sheet NEVER covers the pin (pin sits in viewport center, sheet is below).
 *   - On short viewports (<600px height), default to CLOSED snap.
 *   - Sheet content is provided as children — TrackerView owns VER MÁS + CookiesBlock.
 */
type SnapPoint = 'closed' | 'half' | 'full'

interface TrackerSheetProps {
  children: ReactNode
  isMobile: boolean
  isShortViewport: boolean
  /** Called when sheet height changes — TrackerView invalidates Leaflet size. */
  onHeightChange?: (snap: SnapPoint) => void
  /** Called with drag progress 0..1 for backdrop blur sync (T5 magic #1). */
  onProgressChange?: (progress: number) => void
  /** V9: external snap control — when set, overrides internal state. Used by clipboard button. */
  externalSnap?: SnapPoint | null
}

// T3 spec: closed=38px, half=260px, full=82dvh
// FIX_2 (stracker_hotfix_ui_v8.2): 'full' ahora usa dvh (Dynamic Viewport
// Height) en lugar de innerHeight, para que la barra de navegación del
// navegador mobile NO empuje el panel hacia abajo ni lo colapse.
const SNAP_HEIGHTS_PX: Record<SnapPoint, number> = {
  closed: 38,
  half: 260,
  full: 0, // computed dynamically = 0.82 * dvh (see getSnapHeightPx)
}

// M2 spec: spring stiffness 350, damping 30, mass 0.7
const SPRING = { type: 'spring' as const, stiffness: 350, damping: 30, mass: 0.7 }

function getSnapHeightPx(snap: SnapPoint): number {
  if (snap === 'full') {
    if (typeof window !== 'undefined') {
      // FIX_2: usar 100dvh (dynamic viewport height) si está soportado,
      // caer a innerHeight si no. dvh se ajusta cuando la barra del
      // navegador aparece/desaparece, evitando el colapso del sheet.
      const dvh = window.innerHeight || Math.round((visualViewport?.height ?? window.screen.height) * 0.82)
      return Math.round(dvh * 0.82)
    }
    return 660 // fallback
  }
  return SNAP_HEIGHTS_PX[snap]
}

export function TrackerSheet({
  children,
  isMobile,
  isShortViewport,
  onHeightChange,
  onProgressChange,
  externalSnap,
}: TrackerSheetProps) {
  // FIX_2 (stracker_hotfix_ui_v8.2): Default a 'half' (260px) en lugar de
  // 'closed' (38px). Antes el sheet arrancaba colapsado mostrando SOLO el
  // drag handle, obligando al usuario a adivinar que debía arrastrarlo hacia
  // arriba. Ahora el tablero minimalista es inmediatamente visible tras la
  // carga (criterio_2 de la matriz de verificación v8.2).
  const [internalSnap, setInternalSnap] = useState<SnapPoint>('half')
  const snap = externalSnap ?? internalSnap
  const setSnap = (s: SnapPoint | ((prev: SnapPoint) => SnapPoint)) => {
    if (typeof s === 'function') setInternalSnap(s(internalSnap))
    else setInternalSnap(s)
  }
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  const startYRef = useRef<number | null>(null)
  const startHeightRef = useRef<number>(getSnapHeightPx(snap))

  // Effective snap: clamp 'full' to 'half' on short viewports
  const effectiveSnap: SnapPoint = isMobile && isShortViewport && snap === 'full' ? 'half' : snap

  // Notify parent of snap changes (for invalidateSize + progress)
  useEffect(() => {
    onHeightChange?.(effectiveSnap)
    const closedH = getSnapHeightPx('closed')
    const fullH = getSnapHeightPx('full')
    const curH = getSnapHeightPx(effectiveSnap)
    const progress = fullH > closedH ? Math.max(0, Math.min(1, (curH - closedH) / (fullH - closedH))) : 0
    onProgressChange?.(progress)
  }, [effectiveSnap, onHeightChange, onProgressChange])

  // V6.6 MAP_LIBERATION: the desktop LEFT flex-dock branch (V6.4) and the
  // 9:16 absolute-anchored sheet (V6.5) have BOTH been removed. The dashboard
  // is now a `position: fixed` OVERLAY on top of a full-viewport map:
  //   - Mobile (<768px): full-width bottom sheet (left-0 right-0 bottom-0),
  //     top-rounded corners, snap points (closed=38px / half=260px / full=82dvh).
  //   - Desktop (>=768px): floating bottom-LEFT widget (~400px wide), rounded
  //     all corners, 16px margins. The map's CENTER is never occluded.
  // The snap points work identically on all viewports — the widget just gets
  // constrained width on desktop so the map stays visible behind it.

  // ── BOTTOM SHEET (all viewports) with pixel-precise snap points ──
  const targetHeight = dragHeight != null ? dragHeight : getSnapHeightPx(effectiveSnap)
  // Clamp to [closed, full]
  const closedH = getSnapHeightPx('closed')
  const fullH = getSnapHeightPx('full')
  const clampedHeight = Math.max(closedH, Math.min(fullH, targetHeight))

  const handleTouchStart = (e: React.TouchEvent) => {
    startYRef.current = e.touches[0].clientY
    startHeightRef.current = getSnapHeightPx(snap)
    setDragHeight(getSnapHeightPx(snap))
  }
  const handleTouchMove = (e: React.TouchEvent) => {
    if (startYRef.current == null) return
    const dy = startYRef.current - e.touches[0].clientY // +ve = dragging up (grow)
    const newHeight = startHeightRef.current + dy
    const clamped = Math.max(closedH, Math.min(fullH, newHeight))
    setDragHeight(clamped)
    const progress = fullH > closedH ? (clamped - closedH) / (fullH - closedH) : 0
    onProgressChange?.(progress)
  }
  const handleTouchEnd = () => {
    if (startYRef.current == null) return
    const currentH = dragHeight ?? getSnapHeightPx(snap)
    // Find nearest snap point (in pixels)
    const distances = (['closed', 'half', 'full'] as SnapPoint[]).map(k => ({
      snap: k,
      dist: Math.abs(getSnapHeightPx(k) - currentH),
    }))
    const nearest = distances.sort((a, b) => a.dist - b.dist)[0]
    setSnap(nearest.snap)
    startYRef.current = null
    setDragHeight(null)
  }

  // Cycle snap on handle click: closed → half → full → closed
  const cycleSnap = () => {
    setSnap(prev => prev === 'closed' ? 'half' : prev === 'half' ? 'full' : 'closed')
  }

  // V6.6 MAP_LIBERATION: TrackerSheet is now `position: fixed` (was `absolute`
  // anchoring to the deleted 9:16 column). On MOBILE it stays a full-width
  // bottom sheet (left-0 right-0 bottom-0, top-rounded corners). On DESKTOP
  // it docks to the bottom-LEFT as a floating Apple Maps style widget:
  // constrained width (~400px), rounded ALL corners, 16px margins from the
  // viewport edges. The map's CENTER is never occluded on desktop because the
  // widget sits in the corner with the map filling 100% of the viewport.
  const desktopWidget = !isMobile
  const desktopWidth = 400 // px — Apple Maps widget reference width

  return (
    <motion.div
      ref={sheetRef}
      className={`fixed z-30 pointer-events-auto flex flex-col ${desktopWidget ? 'left-4 right-auto' : 'left-0 right-0'}`}
      style={{
        bottom: desktopWidget ? 16 : 0,
        width: desktopWidget ? desktopWidth : undefined,
        maxWidth: desktopWidget ? 'calc(100vw - 32px)' : undefined,
        height: clampedHeight,
        background: 'rgba(10,10,10,.85)',
        backdropFilter: 'blur(30px) saturate(180%)',
        WebkitBackdropFilter: 'blur(30px) saturate(180%)',
        borderTop: '1px solid rgba(255,255,255,.05)',
        // V6.0: rounded-[28px] top corners for Apple Maps 4000 expansive minimalism.
        // V6.6: desktop widget rounds ALL corners (floating card, not bottom-docked sheet).
        borderRadius: desktopWidget ? '24px' : '28px 28px 0 0',
        boxShadow: desktopWidget
          ? '0 12px 40px rgba(0,0,0,.6), 0 24px 80px rgba(0,0,0,.5)'
          : '0 -8px 32px rgba(0,0,0,.5), 0 -24px 64px rgba(0,0,0,.45)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
      transition={SPRING}
      animate={{ height: dragHeight != null ? clampedHeight : getSnapHeightPx(effectiveSnap) }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Drag handle — clickable to cycle snap */}
      <div
        onClick={cycleSnap}
        className="flex justify-center pt-3 pb-1.5 cursor-pointer flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] active:scale-[0.98]"
        style={{ touchAction: 'none' }}
      >
        <div
          style={{
            width: 40,
            height: 5,
            borderRadius: 3,
            background: 'rgba(255,255,255,.25)',
          }}
        />
      </div>

      {/* Sheet content — scrollable */}
      <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
        {children}
      </div>
    </motion.div>
  )
}
