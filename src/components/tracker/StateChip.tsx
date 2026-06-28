'use client'

/**
 * StateChip — T3 Premium (stracker_v7_ui_evolution)
 *
 * Uber-style floating chip, top-center. Unifies the most critical telemetry
 * into a single high-impact badge: movement mode + place + zone.
 *
 * chip_estado_uber_style spec:
 *   - Floating centralized top (top-4 left-1/2 -translate-x-1/2 z-[9999])
 *   - Thin capsule structure with PULSING LED indicator
 *   - LED color: Verde=Seguro, Naranja=Anomalía, Rojo=Spoof detectado
 *   - LED pulse rate: calm (2.8s) / warn (1.6s) / critical (1.0s)
 *   - Condensed high-legibility text: "En movimiento • Ruta 168" / "Detenido • Casa"
 *
 * Layout: [LED] [movement-icon] [movement-label] | [place · zone]
 */
interface StateChipProps {
  movementIcon: string
  movementLabel: string
  placeLabel: string
  zoneLabel?: string
  zoneColor?: string
  spoofColor: string   // hex — drives the LED color
  spoofLevel: 'trusted' | 'warning' | 'suspicious' | 'spoof_detected'
  isMobile: boolean
}

export function StateChip({
  movementIcon,
  movementLabel,
  placeLabel,
  zoneLabel,
  zoneColor,
  spoofColor,
  spoofLevel,
  isMobile,
}: StateChipProps) {
  const placeText = placeLabel || 'Sin señal'
  const zoneText = zoneLabel ? `• ${zoneLabel}` : ''

  // LED pulse animation by spoof severity (design_system_tokens.status_*)
  const ledAnimation =
    spoofLevel === 'spoof_detected'
      ? 'led-pulse-critical 1s ease-in-out infinite'
      : spoofLevel === 'suspicious' || spoofLevel === 'warning'
        ? 'led-pulse-warn 1.6s ease-in-out infinite'
        : 'led-pulse-calm 2.8s ease-in-out infinite'

  return (
    <div
      className="fixed z-[9999] pointer-events-none flex justify-center"
      style={{
        // V6.0 Apple Maps 4000 — expansive insets: 16px mobile, 32px desktop.
        top: isMobile
          ? 'max(1rem, env(safe-area-inset-top, 1rem))'
          : 'max(2rem, env(safe-area-inset-top, 2rem))',
        left: '50%',
        transform: 'translateX(-50%)',
        // Leave room for floating controls top-right on mobile
        maxWidth: isMobile ? 'calc(100vw - 130px)' : 'calc(100vw - 260px)',
      }}
    >
      <div
        className="flex items-center gap-2 rounded-full px-3.5 py-2 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
        style={{
          background: 'rgba(10,10,10,.85)',
          backdropFilter: 'blur(30px) saturate(180%)',
          WebkitBackdropFilter: 'blur(30px) saturate(180%)',
          border: '1px solid rgba(255,255,255,.05)',
          // V6.0: shadow-2xl equivalent — deeper, softer drop for the floating chip.
          boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 24px 64px rgba(0,0,0,.45)',
        }}
      >
        {/* Pulsing LED — color + rate driven by spoof level */}
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: spoofColor,
            flexShrink: 0,
            boxShadow: `0 0 8px ${spoofColor}, 0 0 16px ${spoofColor}80`,
            animation: ledAnimation,
          }}
        />
        <span style={{ fontSize: 14, lineHeight: 1 }}>{movementIcon}</span>
        <span
          className="font-semibold truncate"
          style={{
            color: 'rgba(255,255,255,.92)',
            fontSize: isMobile ? 12 : 13,
            letterSpacing: '-0.01em',
            maxWidth: isMobile ? 130 : 200,
          }}
        >
          {movementLabel}
        </span>
        <span style={{ color: 'rgba(255,255,255,.2)', fontSize: 13 }}>|</span>
        <span
          className="truncate"
          style={{
            color: 'rgba(255,255,255,.55)',
            fontSize: isMobile ? 11 : 12,
            fontWeight: 500,
          }}
        >
          {placeText} {zoneText && <span style={{ opacity: 0.6 }}>{zoneText}</span>}
        </span>
      </div>
    </div>
  )
}
