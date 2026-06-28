'use client'

/**
 * MapErrorBoundary — stracker_hotfix_map_data_safety
 *
 * PROBLEM: When the backend returns malformed location data (a single object
 * instead of an array, a null payload, a shape the renderer doesn't expect),
 * react-leaflet's <Marker>/<Polyline>/<Circle> children throw inside render.
 * Because the <MapContainer> is the topmost element of the viewport, a single
 * thrown render error turns the whole screen BLACK (React unmounts the subtree
 * above the nearest error boundary — and there wasn't one).
 *
 * FIX: Wrap the map subtree in a class-based ErrorBoundary. On any render
 * error inside the map (bad coords, non-array payload, leaflet internal
 * crash), we fall back to <MapPlaceholder /> — a friendly, on-brand message
 * with a retry button. The user never sees a "pantalla de la muerte".
 *
 * NOTE: React ErrorBoundary MUST be a class component. Hooks (useEffect etc.)
 * cannot catch render errors — only commit-phase errors. This is a hard React
 * constraint, not a style choice.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { TriangleAlert, RotateCcw, MapPinOff } from 'lucide-react'

interface MapErrorBoundaryProps {
  children: ReactNode
  /** Optional callback fired when an error is caught (for telemetry/logging). */
  onError?: (error: Error, info: ErrorInfo) => void
}

interface MapErrorBoundaryState {
  hasError: boolean
  error: Error | null
  /** Bumped to force-remount the children subtree on retry. */
  retryKey: number
}

export class MapErrorBoundary extends Component<MapErrorBoundaryProps, MapErrorBoundaryState> {
  constructor(props: MapErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, retryKey: 0 }
  }

  static getDerivedStateFromError(error: Error): Partial<MapErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // DEBUG_DE_ESTADO: log full error + component stack so the operator can
    // see exactly what came from the server that broke the array.
    console.error('[MAP_ERROR_BOUNDARY] Render crash in map subtree:', error)
    console.error('[MAP_ERROR_BOUNDARY] Component stack:', info.componentStack)
    console.error('[MAP_ERROR_BOUNDARY] Error message:', error.message)
    this.props.onError?.(error, info)
  }

  handleRetry = (): void => {
    // Clear the error + bump the key so the children remount fresh.
    // This re-runs the data parsers (which now sanitize to arrays), so a
    // transient bad payload won't permanently brick the map.
    this.setState((prev) => ({ hasError: false, error: null, retryKey: prev.retryKey + 1 }))
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <MapPlaceholder error={this.state.error} onRetry={this.handleRetry} />
    }
    // key={retryKey} forces a clean remount on retry — clears any stale
    // leaflet internal state from the crashed instance.
    return <div key={this.state.retryKey} className="contents">{this.props.children}</div>
  }
}

// ══════════════════════════════════════════════════════════════════
// MapPlaceholder — the friendly fallback UI.
// Apple Maps 4000 aesthetic: dark glass, Apple blue accent, 48px touch
// targets, backdrop-blur. Matches the rest of the tracker HUD.
// ══════════════════════════════════════════════════════════════════
interface MapPlaceholderProps {
  error: Error | null
  onRetry: () => void
}

export function MapPlaceholder({ error, onRetry }: MapPlaceholderProps) {
  const msg = error?.message ?? 'Error desconocido'
  // Truncate long error messages so the placeholder stays compact on mobile.
  const shortMsg = msg.length > 140 ? msg.slice(0, 137) + '…' : msg

  return (
    <div
      className="absolute inset-0 z-0 flex items-center justify-center p-6"
      style={{ background: '#0b0f14' }}
      role="alert"
      aria-live="assertive"
      aria-label="Error de carga del mapa"
    >
      <div
        className="w-full max-w-md rounded-3xl p-6 md:p-8 text-center"
        style={{
          background: 'rgba(10, 10, 10, 0.85)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.6)',
        }}
      >
        {/* Icon stack: map-off behind a warning triangle, Apple-blue glow */}
        <div className="relative mx-auto mb-5 h-16 w-16">
          <div
            className="absolute inset-0 rounded-full"
            style={{ background: 'rgba(10, 132, 255, 0.12)', filter: 'blur(12px)' }}
            aria-hidden
          />
          <div className="relative flex h-16 w-16 items-center justify-center">
            <MapPinOff className="h-9 w-9 text-white/25" strokeWidth={1.5} />
            <TriangleAlert
              className="absolute h-7 w-7"
              style={{ color: '#0a84ff' }}
              strokeWidth={2}
            />
          </div>
        </div>

        <h2
          className="mb-2 font-semibold text-white"
          style={{ fontSize: 'clamp(1.05rem, 2.5vw, 1.25rem)', letterSpacing: '-0.01em' }}
        >
          Error de carga del mapa
        </h2>
        <p
          className="mb-1 text-white/60"
          style={{ fontSize: 'clamp(0.875rem, 2vw, 0.95rem)' }}
        >
          Los datos recibidos no pudieron renderizarse. Reintenta la importación.
        </p>
        {/* DEBUG_DE_ESTADO: surface a short, sanitized version of the actual
            error so the operator can see what broke — without leaking it
            into a full stack trace on the user-facing UI. */}
        {shortMsg && (
          <p
            className="mt-3 mb-4 break-words font-mono text-white/35"
            style={{ fontSize: '0.72rem', lineHeight: 1.4 }}
          >
            {shortMsg}
          </p>
        )}

        <button
          type="button"
          onClick={onRetry}
          className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl font-semibold text-white transition-transform active:scale-[0.98] hover:scale-[1.01]"
          style={{
            minHeight: '48px',
            background: '#0a84ff',
            boxShadow: '0 8px 24px rgba(10, 132, 255, 0.35)',
            fontSize: 'clamp(0.95rem, 2.2vw, 1rem)',
          }}
        >
          <RotateCcw className="h-5 w-5" strokeWidth={2.2} />
          Reintentar carga
        </button>
      </div>
    </div>
  )
}

export default MapErrorBoundary
