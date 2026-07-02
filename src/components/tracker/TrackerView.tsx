'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { ReactNode } from 'react'
import dynamic from 'next/dynamic'
import {
  Footprints, Car, Bus, Moon, PersonStanding,
  Wifi, WifiOff, Smartphone,
  Signal, SignalHigh, SignalMedium, SignalLow,
  Battery, BatteryFull, BatteryMedium, BatteryLow, BatteryWarning,
  Home, Briefcase, Music, Building2,
  Circle as CircleIcon, CircleAlert, CircleX, OctagonX,
  Clipboard, ClipboardCheck, Check, Microscope, Download,
  ChevronRight, Plane, Navigation,
  TriangleAlert, Info, Activity, Radio,
} from 'lucide-react'
// V8 LEGACY_CODE_ERADICATION: CookiesBlock and CookieDrawer removed.
// These components polled /api/cookies/status every 2min and POSTed to
// /api/cookies on paste — both endpoints are absent from the Python
// backend, causing massive 404 spam in production console. The cookie
// management UI is gone; the backend uses Google Account cookies stored
// in the gist, not browser-supplied cookies.
// HOTFIX stracker_map_data_safety: ErrorBoundary wraps the map subtree so a
// malformed payload (non-array, null coords, leaflet internal crash) shows a
// friendly MapPlaceholder instead of a black "pantalla de la muerte".
import { MapErrorBoundary } from './MapErrorBoundary'
import { DynamicIsland, type IslandAlert } from './DynamicIsland'
import { SpeedGauge } from './SpeedGauge'
import { MapStyleInyector, computePhase } from './MapStyleInyector'
import { TrackerSheet } from './TrackerSheet'
import { FloatingControls } from './FloatingControls'
import { AnalyticsPanel } from './AnalyticsPanel'
// INFRA_01 (stracker_v5.3_integration): authenticated API client + session.
import { fetchWithAuth } from '@/lib/api-client'
import { ensureSession } from '@/lib/auth'
// INTEL_01 (stracker_v5.4_intelligence): reactive notifications + pattern engine.
import { requestNotificationPermission, evaluateAlerts, type AlertState } from '@/lib/notifications'
// V5.7 NAV: heading system + snap-to-door offset logic.
import { computeHeading, computeSnapOffset, getDisplayPosition, normalizeWgs84, computeDriftReport, computeMapSyncAction, snapToRoad, type HeadingState, type SnapState, type GhostPoint as NavGhostPoint } from '@/lib/nav-helpers'
import { TimelineBar } from './TimelineBar'
// V5.8 INFRA_REALTIME_SOCKETS: Socket.io client for WebSocket streaming.
// Replaces client-side HTTP polling with server-pushed location_update events.
// The socket connects via the Caddy gateway: io("/?XTransformPort=3005").
// Falls back to HTTP polling if the socket is unavailable (production without
// the gateway service, or gateway down).
import { io as createSocket, type Socket } from 'socket.io-client'

// ══════════════════════════════════════════════════════════════════
// FIX_3 (stracker_hotfix_ui_v8.1): Token -> lucide-react icon maps.
// State-derivation helpers stay pure (return string tokens), while
// every render site resolves the token to a vector icon via these
// tables. Emojis are PURGED from the entire bottom tablero.
// ══════════════════════════════════════════════════════════════════
type LucideCmp = typeof Car
const MOVEMENT_ICON: Record<string, LucideCmp> = {
  walk: Footprints,
  car: Car,
  bus: Bus,
  sleep: Moon,
  still: PersonStanding,
}
const NETWORK_ICON: Record<string, LucideCmp> = {
  wifi: Wifi,
  mobile: Smartphone,
  offline: WifiOff,
}
const PLACE_ICON: Record<string, LucideCmp> = {
  home: Home,
  work: Briefcase,
  nightlife: Music,
  building: Building2,
}
const SPOOF_ICON: Record<string, LucideCmp> = {
  trusted: CircleIcon,
  warning: CircleAlert,
  suspicious: CircleAlert,
  spoof_detected: OctagonX,
}

function resolveMovementIcon(token: string): LucideCmp {
  return MOVEMENT_ICON[token] ?? PersonStanding
}
function resolveNetworkIcon(token: string): LucideCmp {
  return NETWORK_ICON[token] ?? WifiOff
}

// FIX_3: map a network TYPE string (WIFI/4G/OFFLINE) to a token for resolveNetworkIcon
function networkTypeToToken(type: string): string {
  const t = (type || '').toUpperCase()
  if (t.includes('WIFI')) return 'wifi'
  if (t.includes('4G') || t.includes('LTE') || t.includes('3G') || t.includes('2G') || t.includes('MOBILE') || t.includes('CELLULAR')) return 'mobile'
  if (t.includes('OFFLINE') || !t) return 'offline'
  return 'offline'
}
function resolvePlaceIcon(token: string): LucideCmp {
  return PLACE_ICON[token] ?? Radio
}
function resolveSpoofIcon(level: string): LucideCmp {
  return SPOOF_ICON[level] ?? CircleIcon
}

// FIX_3: shared Apple Maps Minimalist glass className per spec.
// UI_REFACTOR_01 (stracker_core_ui v5.2-rev): Apple Maps Minimalist glass.
// bg-zinc-900/40 backdrop-blur-xl + border rgba(255,255,255,0.08) per spec.
// V5.5 Deep Black: glass pill — rgba(10,10,10,.85) + blur(30px) + border 0.05.
const GLASS_PILL = 'bg-[#0a0a0a]/85 backdrop-blur-xl border border-white/[0.05] hover:bg-white/10 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]'

// Dynamic import Leaflet (no SSR)
const MapContainer = dynamic(() => import('react-leaflet').then(m => m.MapContainer), { ssr: false })
const TileLayer = dynamic(() => import('react-leaflet').then(m => m.TileLayer), { ssr: false })
const Polyline = dynamic(() => import('react-leaflet').then(m => m.Polyline), { ssr: false })
const Marker = dynamic(() => import('react-leaflet').then(m => m.Marker), { ssr: false })
const Circle = dynamic(() => import('react-leaflet').then(m => m.Circle), { ssr: false })

// ══════════════════════════════════════════════════════════════════
// TYPES — STRACKER Apple Maps Dark Minimalist
// ══════════════════════════════════════════════════════════════════
interface HudSlot { id: string; text: string }
interface GpsGroup { place: string; lat: number | null; lat_str: string; lng: number | null; lng_str: string; accuracy: string; signal: string }
interface SessionGroup { duration: string; screen_on: string; screen_off: string }
interface SystemGroup { network: string; battery_raw: string; motion_raw: string }
interface VerMasEvent { msg: string; color: string }
interface GhostZone { name: string; duration: string; color: string }
interface MapData { lat: number | null; lng: number | null; lat_str: string; lng_str: string; show_speed: boolean; speed_label: string; mode: string; is_home: boolean; auto_unlock_camera: boolean }
interface Overlays { spoof: boolean; signal: boolean; alert_loop: boolean }
interface DiagnosticsGroup { ws_latency_ms: number; last_tick_age_s: number; event_queue_depth: number; snapshot_drift: number; kernel_uptime_s: number }

interface UIState {
  hud: HudSlot[]
  state_strip: string
  ver_mas: {
    gps: GpsGroup
    session: SessionGroup
    system: SystemGroup
    events: VerMasEvent[]
    ghostrail: GhostZone[]
    diagnostics: DiagnosticsGroup
  }
  overlays: Overlays
  toast: string | null
  map: MapData
  page_title: string
}

interface EventItem {
  seq: number
  type: string
  payload: Record<string, any>
  ts: string
}

interface SnapshotData {
  points: any[]
  state: {
    ui?: UIState
    spoof?: { bayesian_risk_score?: number; flag?: string; risk?: number; label?: string }
    [k: string]: any
  } | null
  ghostrail_pts: { lat: number; lng: number; t?: string; zone?: string }[]
  _meta: {
    tick: number
    event_seq: number
    snapshot_version: number
    architecture: string
  }
}

// ══════════════════════════════════════════════════════════════════
// SPOOF ENGINE — CA1 (Gemini roast): single source of truth = backend.
// Frontend NO re-derives spoof level from raw telemetry. It maps the
// backend's `state.spoof.{level, signals, risk}` to the visual badge.
// The old deriveSpoofLevel() (8 signals, 80 lines) is GONE — no drift.
// ══════════════════════════════════════════════════════════════════
type SpoofLevel = 'trusted' | 'warning' | 'suspicious' | 'spoof_detected'

interface SpoofResult {
  level: SpoofLevel
  score: number          // 0-100 (mirrors backend risk)
  icon: string           // token: 'trusted' | 'warning' | 'suspicious' | 'spoof_detected'
  color: string          // hex color for the dot
  strongSignalCount: number
  signals: string[]      // which signals fired (from backend)
}

// V5.5 Deep Black: spoof severity is conveyed by pulse RATE (calm/warn/
// critical), not by color. All LEDs are monochrome white.
const SPOOF_VISUALS: Record<SpoofLevel, { icon: string; color: string }> = {
  trusted: { icon: 'trusted', color: 'rgba(255,255,255,0.85)' },
  warning: { icon: 'warning', color: 'rgba(255,255,255,0.85)' },
  suspicious: { icon: 'suspicious', color: 'rgba(255,255,255,0.9)' },
  spoof_detected: { icon: 'spoof_detected', color: '#ffffff' },
}

function mapSpoofFromBackend(snapshot: SnapshotData | null): SpoofResult {
  const DEFAULT: SpoofResult = { level: 'trusted', score: 0, icon: 'trusted', color: 'rgba(255,255,255,0.85)', strongSignalCount: 0, signals: [] }
  if (!snapshot?.state) return DEFAULT
  const spoof = snapshot.state.spoof
  if (!spoof) return DEFAULT

  // Backend is canonical: level + signals + risk all computed in _detect_spoof()
  const level = (spoof.level as SpoofLevel) || 'trusted'
  const signals: string[] = spoof.signals || []
  const score = typeof spoof.risk === 'number' ? spoof.risk : 0
  const visuals = SPOOF_VISUALS[level] || SPOOF_VISUALS.trusted

  // strongSignalCount: backend signals are all "strong" by design (each one
  // contributed to the risk score). Keep the count for diagnostics.
  return {
    level,
    score,
    icon: visuals.icon,
    color: visuals.color,
    strongSignalCount: signals.length,
    signals,
  }
}

// ══════════════════════════════════════════════════════════════════
// AT_1 (stracker_v8_hyper_premium): Solar shadow engine.
// Computes a directional box-shadow offset from the time-of-day so the
// LiveMarker pin appears lit by the real sun. At noon the shadow is a
// tight halo beneath; at 18:00 it stretches east; at night it fades to a
// neutral ambient glow. Santa Fe (~31°S) — sun still tracks E→W so the
// simple linear model holds for visual purposes.
// ══════════════════════════════════════════════════════════════════
function computeSolarShadow(date: Date): { offsetX: number; offsetY: number; blur: number; opacity: number; color: string } {
  const h = date.getHours() + date.getMinutes() / 60
  // Daylight window 06:00–18:00. Outside = night (neutral ambient).
  const isDaylight = h >= 6 && h <= 18
  if (!isDaylight) {
    // Night: cool ambient halo, no directional component
    return { offsetX: 0, offsetY: 3, blur: 6, opacity: 0.22, color: '10,20,40' }
  }
  // Linear position within the daylight arc: -1 at 6am, 0 at noon, +1 at 6pm
  const dayProgress = (h - 12) / 6 // [-1, +1]
  // Sun elevation factor: 0 at horizon (6/18h), 1 at zenith (12h)
  const elevation = Math.cos(dayProgress * (Math.PI / 2)) // 0..1
  // Shadow points opposite the sun. Morning sun in east → shadow west (−X).
  // Evening sun in west → shadow east (+X).
  const offsetX = dayProgress * 9 // max ±9px east-west stretch
  // Shadow length grows as sun lowers (inverse of elevation)
  const offsetY = 3 + (1 - elevation) * 5 // 3px (noon) → 8px (horizon)
  const blur = 4 + (1 - elevation) * 6 // 4px (noon) → 10px (horizon)
  // Opacity peaks at midday when sun is brightest
  const opacity = 0.18 + elevation * 0.22 // 0.18 → 0.40
  // Warm tint at golden hours (6-8am, 4-6pm), neutral at noon
  const isGolden = h < 8 || h > 16
  const color = isGolden ? '60,30,5' : '0,0,0'
  return { offsetX, offsetY, blur, opacity, color }
}

// ══════════════════════════════════════════════════════════════════
// LIVE MARKER — Apple Maps style pulsing pin (z-index: 9999)
// T5 magic #4 (Accuracy Pulse Scaling): halo radius scales with GPS
// accuracy. Low accuracy (>60m) = larger, softer halo (uncertainty).
// High accuracy (<=20m) = tight, crisp halo (confidence).
// AT_1: box-shadow now includes a directional solar shadow computed from
// the current time-of-day, giving the pin tactile volume + real lighting.
// FIX_2 (stracker_hotfix_ui_v8.1): Pin visibility hardening —
//   1) explicit `live-marker-pin` className (globals.css enforces
//      display:block + opacity:1 + visible background so no inherited
//      `display:none`/`opacity:0` from any ancestor can hide the pin)
//   2) zIndexOffset={10000} keeps the marker above every tile/overlay pane
//   3) lat/lng null/NaN guards are enforced at the call site, but we also
//      bail out here with a no-op render if coords are invalid
//   4) Pin size bumped 16px -> 20px with a brighter halo + white core dot
//      so the target reads instantly against the dark CartoDB tiles
// ══════════════════════════════════════════════════════════════════
function LiveMarker({ lat, lng, speedLabel, accuracy, solarDate, heading, headingLatch }: {
  lat: number
  lng: number
  speedLabel: string
  accuracy?: number
  solarDate?: Date
  heading?: number | null
  headingLatch?: boolean
}) {
  // FIX_2: defensive guard — never render a marker with invalid coords
  if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return null
  // T5 #4: scale halo by accuracy. 0-20m tight, 20-60m medium, >60m wide
  const acc = accuracy ?? 0
  const haloScale = acc > 60 ? 1.6 : acc > 20 ? 1.2 : 1.0
  const haloOpacity = acc > 60 ? 0.45 : acc > 20 ? 0.35 : 0.25
  // V5.5: halo color is monochrome white (Deep Black aesthetic). The only
  // Apple blue is the pin core itself + the heading arrow.
  const haloColor = '255,255,255'
  // AT_1: solar shadow — recompute each render (LiveMarker remounts on pos change)
  const sun = computeSolarShadow(solarDate ?? new Date())
  const solarShadow = `${sun.offsetX.toFixed(1)}px ${sun.offsetY.toFixed(1)}px ${sun.blur}px rgba(${sun.color},${sun.opacity.toFixed(2)})`

  // V5.7 NAV_02_HEADING_SYSTEM: directional indicator (heading arrow).
  // Rendered as a small Apple-blue wedge that rotates around the pin.
  // When heading is null (no data) or latched (stationary), the arrow holds
  // its last position to avoid jitter. When null at init, no arrow is shown.
  const hasHeading = heading != null && isFinite(heading)
  const headingArrow = hasHeading
    ? `<div style="position:absolute;top:50%;left:50%;width:0;height:0;transform:translate(-50%,-50%) rotate(${heading}deg);pointer-events:none">
          <div style="position:absolute;top:-22px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:8px solid #0a84ff;opacity:${headingLatch ? 0.5 : 0.9};filter:drop-shadow(0 0 3px rgba(10,132,255,.6));transition:transform 400ms ease-out,opacity 300ms ease"></div>
       </div>`
    : ''

  return (
    <Marker
      position={[lat, lng]}
      icon={typeof window !== 'undefined' ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const L = require('leaflet')
        const speedHtml = speedLabel
          ? `<div style="font-size:10px;font-weight:600;color:#f5f5f7;background:rgba(0,0,0,.65);padding:1px 6px;border-radius:6px;margin-top:3px;white-space:nowrap;backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,.08)">${speedLabel}</div>`
          : ''
        return L.divIcon({
          // FIX_2: explicit className so globals.css can enforce visibility
          className: 'live-marker-pin',
          html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none;width:100%;height:100%;justify-content:center">
            ${headingArrow}
            <div style="width:20px;height:20px;border-radius:50%;background:#0a84ff;border:3px solid #f5f5f7;box-shadow:0 0 14px rgba(10,132,255,.65),0 2px 8px rgba(0,0,0,.4),${solarShadow};position:relative">
              <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:6px;height:6px;border-radius:50%;background:#f5f5f7;box-shadow:0 0 4px rgba(255,255,255,.8)"></div>
              <div style="position:absolute;inset:-${8 * haloScale}px;border-radius:50%;border:2px solid rgba(${haloColor},${haloOpacity});animation:applePulse 2.5s ease-out infinite"></div>
              <div style="position:absolute;inset:-${16 * haloScale}px;border-radius:50%;border:1.5px solid rgba(${haloColor},${haloOpacity * 0.4});animation:applePulse 2.5s ease-out infinite .5s"></div>
            </div>
            ${speedHtml}
          </div>
          <style>@keyframes applePulse{0%{transform:scale(.9);opacity:.5}100%{transform:scale(1.8);opacity:0}}</style>`,
          iconSize: [56, 56],
          iconAnchor: [28, 28],
        })
      })() : undefined}
      zIndexOffset={10000}
    />
  )
}

// ══════════════════════════════════════════════════════════════════
// V6.0 stracker_fix_geospatial_drift — DEBUG_OVERLAY_INJECTION
// ══════════════════════════════════════════════════════════════════
// Renders a red crosshair at the RAW backend coordinate and a blue
// circle at the RENDERED pin position. When the two diverge by > 1m,
// both markers appear so the operator can SEE the drift in seconds.
// When drift is zero, neither marker is rendered (the LiveMarker alone
// is sufficient). A thin red line connects the two for emphasis.
//
// The drift distance is shown as a small label so the magnitude is
// readable without opening the console.
// ══════════════════════════════════════════════════════════════════
function DriftDebugMarker({
  rawLat,
  rawLng,
  renderedLat,
  renderedLng,
  driftM,
  snapReason,
}: {
  rawLat: number
  rawLng: number
  renderedLat: number
  renderedLng: number
  driftM: number
  snapReason: string | null
}) {
  if (!isFinite(rawLat) || !isFinite(rawLng)) return null
  if (!isFinite(renderedLat) || !isFinite(renderedLng)) return null
  // Suppress the overlay when drift is sub-meter (no visual clutter).
  if (driftM < 1) return null

  return (
    <>
      {/* Red crosshair at the RAW backend coordinate */}
      <Marker
        position={[rawLat, rawLng]}
        interactive={false}
        icon={typeof window !== 'undefined' ? (() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const L = require('leaflet')
          return L.divIcon({
            className: 'drift-debug-raw',
            html: `<div style="position:relative;width:36px;height:36px;pointer-events:none">
              <div style="position:absolute;top:50%;left:0;width:100%;height:2px;background:#ff3b30;transform:translateY(-50%);box-shadow:0 0 4px rgba(255,59,48,.6)"></div>
              <div style="position:absolute;left:50%;top:0;height:100%;width:2px;background:#ff3b30;transform:translateX(-50%);box-shadow:0 0 4px rgba(255,59,48,.6)"></div>
              <div style="position:absolute;top:50%;left:50%;width:8px;height:8px;border:2px solid #ff3b30;border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,59,48,.15)"></div>
              <div style="position:absolute;top:-18px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:700;color:#ff3b30;background:rgba(0,0,0,.75);padding:1px 5px;border-radius:4px;white-space:nowrap;border:1px solid rgba(255,59,48,.3)">RAW ${driftM.toFixed(1)}m${snapReason ? ' · ' + snapReason : ''}</div>
            </div>`,
            iconSize: [36, 36],
            iconAnchor: [18, 18],
          })
        })() : undefined}
        zIndexOffset={9990}
      />
      {/* Blue circle at the RENDERED pin position (drift indicator) */}
      <Marker
        position={[renderedLat, renderedLng]}
        interactive={false}
        icon={typeof window !== 'undefined' ? (() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const L = require('leaflet')
          return L.divIcon({
            className: 'drift-debug-rendered',
            html: `<div style="position:relative;width:48px;height:48px;pointer-events:none">
              <div style="position:absolute;top:50%;left:50%;width:36px;height:36px;border:2px solid #0a84ff;border-radius:50%;transform:translate(-50%,-50%);background:rgba(10,132,255,.08);animation:driftPulse 2s ease-out infinite"></div>
              <div style="position:absolute;top:-16px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:700;color:#0a84ff;background:rgba(0,0,0,.75);padding:1px 5px;border-radius:4px;white-space:nowrap;border:1px solid rgba(10,132,255,.3)">PIN</div>
            </div>
            <style>@keyframes driftPulse{0%{transform:translate(-50%,-50%) scale(1);opacity:.7}100%{transform:translate(-50%,-50%) scale(1.4);opacity:0}}</style>`,
            iconSize: [48, 48],
            iconAnchor: [24, 24],
          })
        })() : undefined}
        zIndexOffset={9989}
      />
      {/* Red connecting line from raw → rendered */}
      <Polyline
        positions={[[rawLat, rawLng], [renderedLat, renderedLng]]}
        pathOptions={{
          color: '#ff3b30',
          weight: 1.5,
          opacity: 0.6,
          dashArray: '4,4',
        }}
      />
    </>
  )
}

// ══════════════════════════════════════════════════════════════════
// GHOST TRAIL — B3+B5: SINGLE route with age-based opacity fading
// Apple Maps style: recent = strong, old = faded. NO duplicate layers.
// AT_3 (stracker_v8_hyper_premium): Linear trajectory fading — the leading
// segment (newest 5 points) gets a comet-tail glow + a brighter head, so
// the trail reads like a long-exposure light streak rather than a drawn line.
// Also bumped segment cap to 16 for a smoother age gradient.
// ══════════════════════════════════════════════════════════════════
function GhostTrail({ routedPoints }: { routedPoints: [number, number][] }) {
  if (!routedPoints || routedPoints.length < 2) return null

  const total = routedPoints.length
  // AT_3: bumped cap 8 → 16 for smoother gradient tail
  const NUM_SEGMENTS = Math.min(16, Math.max(2, Math.ceil(total / 12)))
  const segmentSize = Math.ceil(total / NUM_SEGMENTS)

  const segments: { pts: [number, number][]; opacity: number; weight: number; isHead: boolean }[] = []
  for (let i = 0; i < NUM_SEGMENTS; i++) {
    const start = i * segmentSize
    const end = Math.min(start + segmentSize + 1, total) // +1 for overlap continuity
    const pts = routedPoints.slice(start, end)
    if (pts.length < 2) continue

    // Age-based opacity: oldest = 0.10, newest = 1.0 (AT_3: deeper fade tail)
    const ageFraction = i / (NUM_SEGMENTS - 1) // 0 = oldest, 1 = newest
    const opacity = 0.10 + ageFraction * 0.90 // range [0.10, 1.0]
    const weight = 1.8 + ageFraction * 2.6 // range [1.8, 4.4]
    // AT_3: the final segment is the "comet head" — gets the glow class
    const isHead = i === NUM_SEGMENTS - 1

    segments.push({ pts, opacity, weight, isHead })
  }

  return (
    <>
      {/* V5.7 NAV_01_PATH_ENGINE: base logical path polyline.
          Per spec: stroke color #0a84ff, strokeOpacity 0.6, strokeWeight 4.
          Rendered BENEATH the comet-tail segments so the age gradient still
          reads on top, but the underlying "logical route" is always visible
          as a continuous line connecting all timestamped points. */}
      <Polyline
        key="nav-path-base"
        positions={routedPoints}
        pathOptions={{
          color: '#0a84ff',
          opacity: 0.6,
          weight: 4,
          lineCap: 'round',
          lineJoin: 'round',
        }}
      />
      {segments.map((seg, i) => (
        <Polyline
          key={`ghost-seg-${i}`}
          positions={seg.pts}
          // AT_3: comet-tail glow on the leading segment via className
          className={seg.isHead ? 'ghost-comet-head' : undefined}
          pathOptions={{
            color: '#0a84ff',
            weight: seg.weight,
            opacity: seg.opacity,
            lineCap: 'round',
            lineJoin: 'round',
          }}
        />
      ))}
    </>
  )
}

// ══════════════════════════════════════════════════════════════════
// MAGIA2: LoiteringHeatmap — Thermal Cluster of Detention
// Draws a pulsing red radius at locations where the target stayed
// within <15m for >10 minutes. Exposes visited places of interest.
// ══════════════════════════════════════════════════════════════════
function LoiteringHeatmap({ lat, lng, radiusM, durationMin }: {
  lat: number; lng: number; radiusM: number; durationMin: number
}) {
  // V5.5: LoiteringHeatmap is monochrome — concentric white halo, intensity
  // by dwell duration. No red/orange/yellow in the Deep Black aesthetic.
  const intensity = Math.min(1, durationMin / 120) // cap at 2h
  const fillOpacity = 0.04 + intensity * 0.08 // 0.04 → 0.12
  const color = 'rgba(255,255,255,0.5)'
  return (
    <Circle
      center={[lat, lng] as any}
      radius={radiusM}
      pathOptions={{
        color,
        weight: 1,
        opacity: 0.4,
        fillColor: color,
        fillOpacity,
      }}
    />
  )
}

// ══════════════════════════════════════════════════════════════════
// COMPACT CIRCULAR BADGE — for metrics display (B3: flex 0 0 auto)
// FIX_3: glass pill per Apple Maps Minimalist spec.
// ══════════════════════════════════════════════════════════════════
function MetricBadge({
  icon, label, value, color,
}: {
  icon: ReactNode; label: string; value: string; color: string
}) {
  return (
    <div
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-full flex-shrink-0 ${GLASS_PILL}`}
    >
      {icon}
      <span className="font-bold uppercase tracking-wider whitespace-nowrap" style={{ color, fontSize: 'clamp(9px, 2vw, 11px)' }}>{value}</span>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// MOVEMENT ICON — M1+M2: SLEEP/STILL/WALK/BUS/CAR
// FIX_3: lucide-react vector icons replace emojis.
// ══════════════════════════════════════════════════════════════════
function MovementIconStandalone({ mode, isActive }: { mode: string; isActive: boolean }) {
  const upper = (mode || '').toUpperCase()
  let token = 'still'
  if (upper === 'SLEEP' || upper === 'NONI' || upper === 'DORMIDA') token = 'sleep'
  else if (upper === 'WALK' || upper === 'A PIE' || upper === 'ON_FOOT') token = 'walk'
  else if (upper === 'IN_VEHICLE' || upper === 'EN AUTO' || upper === 'CAR') token = 'car'
  else if (upper === 'BUS' || upper === 'EN COLECTIVO') token = 'bus'
  else if (upper === 'STILL' || upper === 'STATIC' || upper === 'QUIETA') token = 'still'
  else if (upper === 'ON_BICYCLE' || upper === 'BICYCLE') token = 'walk'

  const Icon = MOVEMENT_ICON[token] ?? PersonStanding
  return (
    <div
      className="flex items-center justify-center rounded-full flex-shrink-0"
      style={{
        width: 40,
        height: 40,
        background: isActive ? 'rgba(255,255,255,.06)' : 'rgba(255,255,255,.02)',
        border: isActive ? '1px solid rgba(255,255,255,.12)' : '1px solid rgba(255,255,255,0.04)',
        backdropFilter: 'blur(30px)',
        WebkitBackdropFilter: 'blur(30px)',
        color: isActive ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.65)',
      }}
    >
      <Icon size={22} strokeWidth={1.5} />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// SPOOF BADGE V2 — M3: VISUAL ONLY, no text labels
// V9: compact inline sizing matching other Estado row items.
// FIX_3: lucide Circle components with color tints replace emoji dots.
// ══════════════════════════════════════════════════════════════════
function SpoofBadgeV2({ result }: { result: SpoofResult }) {
  const bgMap: Record<SpoofLevel, string> = {
    trusted: 'rgba(255,255,255,.04)',
    warning: 'rgba(255,255,255,.05)',
    suspicious: 'rgba(255,255,255,.06)',
    spoof_detected: 'rgba(255,255,255,.08)',
  }
  const borderMap: Record<SpoofLevel, string> = {
    trusted: 'rgba(255,255,255,.1)',
    warning: 'rgba(255,255,255,.12)',
    suspicious: 'rgba(255,255,255,.15)',
    spoof_detected: 'rgba(255,255,255,.2)',
  }
  const Icon = SPOOF_ICON[result.level] ?? CircleIcon
  return (
    <div
      className="flex items-center justify-center px-1.5 py-0.5 rounded-full flex-shrink-0"
      style={{
        background: bgMap[result.level],
        border: `1px solid ${borderMap[result.level]}`,
      }}
      title={`Spoof: ${result.level}`}
    >
      <Icon size={12} strokeWidth={2.4} style={{ color: result.color, lineHeight: 1 }} />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// OSRM ROUTING HOOK — F5: SEGMENT-BY-SEGMENT street routing
// NEVER draw straight lines through blocks.
// Routes each consecutive pair of points separately via OSRM,
// concatenating results for a complete road-following trail.
// ══════════════════════════════════════════════════════════════════
function useRoutedTrail(rawPoints: { lat: number; lng: number; t?: string }[]): [number, number][] {
  const [routedPoints, setRoutedPoints] = useState<[number, number][]>([])
  const isRoutingRef = useRef(false)

  useEffect(() => {
    if (!rawPoints || rawPoints.length < 2) {
      requestAnimationFrame(() => setRoutedPoints([]))
      return
    }

    const validPts = rawPoints.filter(p => p.lat != null && p.lng != null && isFinite(p.lat) && isFinite(p.lng))
    if (validPts.length < 2) {
      requestAnimationFrame(() => setRoutedPoints([]))
      return
    }

    // Prevent concurrent routing
    if (isRoutingRef.current) return
    isRoutingRef.current = true

    async function routeSegmentBySegment() {
      const allRoutedPts: [number, number][] = []
      let anyRouteFailed = false

      // Route each consecutive pair of points
      for (let i = 0; i < validPts.length - 1; i++) {
        const from = validPts[i]
        const to = validPts[i + 1]

        // Skip if points are too close (<15m) — just use the point directly
        const dLat = to.lat - from.lat
        const dLng = to.lng - from.lng
        const distM = Math.sqrt(dLat * dLat * 111000 * 111000 + dLng * dLng * 85000 * 85000)
        if (distM < 15) {
          if (allRoutedPts.length === 0) allRoutedPts.push([from.lat, from.lng])
          continue
        }

        const coordsStr = `${from.lng},${from.lat};${to.lng},${to.lat}`

        try {
          const resp = await fetch(`/osrm-route?coords=${encodeURIComponent(coordsStr)}`)
          if (resp.ok) {
            const data = await resp.json()
            if (data.routed && data.points && data.points.length >= 2) {
              // Add all points from this route segment
              // Skip first point if we already have it from previous segment
              const startIdx = allRoutedPts.length > 0 ? 1 : 0
              for (let j = startIdx; j < data.points.length; j++) {
                allRoutedPts.push(data.points[j])
              }
              continue
            }
          }
        } catch {
          // OSRM failed for this segment — fall through to straight line
        }

        // Fallback: straight line between this pair (only this tiny segment)
        anyRouteFailed = true
        if (allRoutedPts.length === 0) allRoutedPts.push([from.lat, from.lng])
        allRoutedPts.push([to.lat, to.lng])
      }

      // V10: [GHOSTRAIL_F5] debug logs removed — production console must stay clean.

      isRoutingRef.current = false
      requestAnimationFrame(() => setRoutedPoints(allRoutedPts))
    }

    routeSegmentBySegment()
  }, [rawPoints])

  return routedPoints
}

// ══════════════════════════════════════════════════════════════════
// GHOSTRAIL LOCALSTORAGE CACHE — safety fallback
// V5.8 SECURITY_FORTRESS: AES-256-GCM encrypted via Web Crypto API.
// The cache is now encrypted at rest — even if localStorage is exfiltrated,
// the ghosttrail history is unreadable without the session-derived key.
// ══════════════════════════════════════════════════════════════════
const GHOSTRAIL_CACHE_KEY = 'stracker_ghostrail_cache'
const GHOSTRAIL_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h

// V5.8: Async encrypted cache write. Fire-and-forget (no await at call site).
// Uses setEncryptedItem which handles AES-256-GCM + PBKDF2 key derivation.
async function cacheGhostrailPoints(pts: { lat: number; lng: number; t?: string; zone?: string }[]) {
  if (typeof window === 'undefined' || pts.length === 0) return
  try {
    const { setEncryptedItem } = await import('@/lib/crypto')
    const payload = { pts, ts: Date.now() }
    await setEncryptedItem(GHOSTRAIL_CACHE_KEY, payload)
  } catch { /* localStorage full or unavailable */ }
}

// V5.8: Async encrypted cache read. Returns [] on any error.
// Handles legacy plaintext format automatically (backward compat).
async function loadCachedGhostrailPoints(): Promise<{ lat: number; lng: number; t?: string; zone?: string }[]> {
  if (typeof window === 'undefined') return []
  try {
    const { getEncryptedItem } = await import('@/lib/crypto')
    const payload = await getEncryptedItem<{ pts: { lat: number; lng: number; t?: string; zone?: string }[]; ts: number }>(GHOSTRAIL_CACHE_KEY)
    if (!payload || !payload.pts || !Array.isArray(payload.pts)) return []
    const age = Date.now() - (payload.ts || 0)
    if (age > GHOSTRAIL_CACHE_MAX_AGE_MS) {
      localStorage.removeItem(GHOSTRAIL_CACHE_KEY)
      return []
    }
    return payload.pts
  } catch { return [] }
}

// ══════════════════════════════════════════════════════════════════
// V6.11 PHASE 1: LIVE_TELEMETRY_SNAPSHOT — Golden Fingerprint
// ══════════════════════════════════════════════════════════════════
// The user performed a physical audit of the Samsung A16 device and
// confirmed the live payload entering NOW is the canonical signature.
// We capture that fingerprint (network state + battery pattern + screen
// state + meta.version + backend-extracted device_label token) and lock
// it in localStorage as the Golden Fingerprint. Any future payload that
// matches this signature — even if the ephemeral session token rotates
// (ziQI → U-AE → ...) — must be labeled "Samsung A16".
//
// Fingerprint format (deterministic, ignore volatile token):
//   NET:<type>/<signal>|BATT:<pct><C|D>|SCR:<state>|VER:<version>
// Examples:
//   NET:WIFI/WEAK|BATT:4C|SCR:ON|VER:v6     → Samsung A16 (locked)
//   NET:WIFI/WEAK|BATT:52C|SCR:ON|VER:v6    → Samsung A16 (locked)
//
// The battery percentage is bucketed (0-9, 10-24, 25-49, 50-74, 75-100)
// so normal discharge doesn't break the fingerprint — only the charging
// state (C/D) is sticky, since charging+low-battery is a strong signal.
// ══════════════════════════════════════════════════════════════════
const GOLDEN_FINGERPRINT_KEY = 'stracker_v611_golden_fingerprint'
const V611_AUDIT_LOG_KEY = 'stracker_v611_audit_log'
const V611_AUDIT_LOG_MAX = 50

// V6.11 Phase 2: stale-data threshold for SCREEN_STATE_TRUTH_ENFORCEMENT.
// If the payload's last_update is older than this, the UI MUST NOT claim
// "Pantalla ON" — it must show "DESCONOCIDO / CACHÉ" instead. Zero
// tolerance for stale data presented as live activity.
const V611_STALE_SCREEN_MS = 3 * 60 * 1000 // 3 minutes (was 15 min in V6.10)

function bucketBattery(pct: number | null | undefined): string {
  if (pct == null) return '?'
  if (pct < 10) return 'low'
  if (pct < 25) return 'q1'
  if (pct < 50) return 'q2'
  if (pct < 75) return 'q3'
  return 'hi'
}

function buildFingerprint(data: any): string {
  const st = data?.state || {}
  const net = st?.network || {}
  const dev = st?.device || {}
  const meta = st?.meta || {}
  const act = st?.activity || {}
  const netType = (net?.type || 'UNK').toString().toUpperCase()
  const netSig = (net?.signal_quality || 'UNK').toString().toUpperCase()
  const batt = bucketBattery(dev?.battery)
  const charging = dev?.charging ? 'C' : 'D'
  const scr = (act?.screen_state || 'UNK').toString().toUpperCase()
  const ver = (meta?.version || 'unk').toString()
  return `NET:${netType}/${netSig}|BATT:${batt}${charging}|SCR:${scr}|VER:${ver}`
}

interface GoldenFingerprint {
  fingerprint: string
  label: string
  capturedAt: number
  deviceId: string
  rawToken: string | null
}

// V6.11: Capture and persist the Golden Fingerprint. Called on every
// fresh /points payload. The FIRST capture locks the label; subsequent
// captures only refresh capturedAt if the fingerprint matches. If the
// fingerprint changes materially (different network/ver), we re-lock —
// this allows the user to re-audit on a new device and the system will
// adopt the new signature as canonical.
function captureGoldenFingerprint(data: any): { label: string; matched: boolean; fingerprint: string } {
  if (typeof window === 'undefined') return { label: 'DESCONOCIDO', matched: false, fingerprint: '' }
  try {
    const fingerprint = buildFingerprint(data)
    const rawToken = (data?.device_label || data?.state?.meta?.device_id || null) as string | null
    const deviceId = (data?.state?.meta?.device_id || 'unknown') as string
    const existingRaw = localStorage.getItem(GOLDEN_FINGERPRINT_KEY)
    let existing: GoldenFingerprint | null = null
    if (existingRaw) {
      try { existing = JSON.parse(existingRaw) } catch { existing = null }
    }
    // First-ever capture → lock as Samsung A16 (per user directive: the
    // device being audited NOW is the Samsung A16).
    if (!existing) {
      const gf: GoldenFingerprint = {
        fingerprint,
        label: 'Samsung A16',
        capturedAt: Date.now(),
        deviceId,
        rawToken,
      }
      localStorage.setItem(GOLDEN_FINGERPRINT_KEY, JSON.stringify(gf))
      return { label: gf.label, matched: true, fingerprint }
    }
    // Already locked — check if the live fingerprint still matches.
    // We allow battery bucket to drift (low/q1/q2/q3/hi) and only
    // re-lock if the network type OR version changed materially.
    const sameNet = existing.fingerprint.includes(`NET:${fingerprint.split('NET:')[1].split('|')[0]}`)
    const sameVer = existing.fingerprint.includes(`VER:${fingerprint.split('VER:')[1]}`)
    if (sameNet && sameVer) {
      // Refresh capturedAt + rawToken (token rotates, signature persists)
      existing.capturedAt = Date.now()
      existing.rawToken = rawToken
      localStorage.setItem(GOLDEN_FINGERPRINT_KEY, JSON.stringify(existing))
      return { label: existing.label, matched: true, fingerprint }
    }
    // Material change → re-lock with the same canonical label (Samsung A16).
    // The user said: "Toma el payload que está entrando AHORA MISMO y
    // úsalo como la firma definitiva para reconocer el A16". So every
    // fresh audit re-binds the signature to "Samsung A16".
    const gf: GoldenFingerprint = {
      fingerprint,
      label: 'Samsung A16',
      capturedAt: Date.now(),
      deviceId,
      rawToken,
    }
    localStorage.setItem(GOLDEN_FINGERPRINT_KEY, JSON.stringify(gf))
    return { label: gf.label, matched: true, fingerprint }
  } catch {
    return { label: 'DESCONOCIDO', matched: false, fingerprint: '' }
  }
}

// V6.11: Resolve the device label for display. Reads the locked Golden
// Fingerprint and returns the canonical label. If no fingerprint is
// locked yet, returns the raw device_label from the backend (which may
// be an ephemeral token like "ziQI" / "U-AE") or "DESCONOCIDO".
function resolveDeviceLabel(data: any): string {
  if (typeof window === 'undefined') return 'DESCONOCIDO'
  try {
    const raw = localStorage.getItem(GOLDEN_FINGERPRINT_KEY)
    if (!raw) {
      const tok = data?.device_label
      if (tok && typeof tok === 'string' && tok.length > 0 && tok !== 'null') return tok
      return 'DESCONOCIDO'
    }
    const gf: GoldenFingerprint = JSON.parse(raw)
    // If the live fingerprint matches the locked one, return the canonical label.
    const live = buildFingerprint(data)
    const sameNet = gf.fingerprint.includes(`NET:${live.split('NET:')[1].split('|')[0]}`)
    const sameVer = gf.fingerprint.includes(`VER:${live.split('VER:')[1]}`)
    if (sameNet && sameVer) return gf.label
    // Mismatch — but per user directive, the audited device is ALWAYS the
    // Samsung A16. So we still return the canonical label and let
    // captureGoldenFingerprint() re-lock on the next poll tick.
    return gf.label
  } catch {
    return 'DESCONOCIDO'
  }
}

// V6.11: Append an entry to the audit log (capped at V611_AUDIT_LOG_MAX).
// Used for forensic post-mortem: every payload arrival records its age,
// fingerprint match, and screen-state decision. Stored as JSON array.
function appendV611AuditLog(entry: {
  ts: number
  ageMs: number
  fingerprint: string
  matched: boolean
  screenDecision: string
  rawToken: string | null
}): void {
  if (typeof window === 'undefined') return
  try {
    const raw = localStorage.getItem(V611_AUDIT_LOG_KEY)
    let log: any[] = []
    if (raw) { try { log = JSON.parse(raw) } catch { log = [] } }
    log.push(entry)
    if (log.length > V611_AUDIT_LOG_MAX) log = log.slice(-V611_AUDIT_LOG_MAX)
    localStorage.setItem(V611_AUDIT_LOG_KEY, JSON.stringify(log))
  } catch { /* localStorage full */ }
}

// V6.11: Compute payload age in milliseconds. The backend returns
// `last_update` (ISO 8601) which is the timestamp of the freshest point.
// We compare against Date.now() to determine staleness.
function computePayloadAgeMs(data: any): number {
  const lu = data?.last_update || data?.state?.meta?.timestamp
  if (!lu) return Number.POSITIVE_INFINITY
  try {
    const t = new Date(lu).getTime()
    if (!isFinite(t)) return Number.POSITIVE_INFINITY
    return Math.max(0, Date.now() - t)
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

// ══════════════════════════════════════════════════════════════════
// HOTFIX stracker_map_data_safety — sanitizePointsArray()
//
// PROBLEM: The backend occasionally emits a SINGLE point object instead of
// an array (e.g. `{"lat":..., "lng":...}` instead of `[{...}]`), or a null
// payload, or a stringified array. react-leaflet's children expect arrays —
// a non-array fed into `.map()` throws inside render, crashing the whole
// map subtree to a black screen.
//
// FIX: Force-array wrapper. Whatever comes in, we coerce to a clean array
// of point-shaped objects. This is applied at EVERY data-ingestion point
// (socket location_update, HTTP poll, ghostrailPts memo) so a malformed
// payload can never reach the leaflet renderers.
//
// DEBUG_DE_ESTADO: the wrapper logs the raw type/shape on every call so the
// operator can see exactly what's arriving from the server. Logs are gated
// behind a module-level flag to avoid console spam in production.
// ══════════════════════════════════════════════════════════════════
const MAP_DATA_DEBUG = process.env.NODE_ENV === 'development'
let mapDataDebugLogged = 0 // rate-limit: only log the first 20 calls per session

function sanitizePointsArray(incoming: unknown, source: string): { lat: number; lng: number; t?: string; zone?: string }[] {
  // DEBUG_DE_ESTADO: surface the raw type so we can diagnose what the server
  // actually sent. Rate-limited to avoid flooding the console on every poll.
  // NOTE: JSON.stringify(undefined) returns undefined (NOT a string), so we
  // must guard the .slice() call — otherwise the debug log itself throws
  // "Cannot read properties of undefined (reading 'slice')", which would
  // defeat the whole purpose of this safety wrapper.
  if (MAP_DATA_DEBUG && mapDataDebugLogged < 20) {
    const isArray = Array.isArray(incoming)
    let valueDesc: string
    if (isArray) {
      valueDesc = `[${(incoming as unknown[]).length} items]`
    } else if (incoming === undefined) {
      valueDesc = 'undefined'
    } else if (incoming === null) {
      valueDesc = 'null'
    } else {
      // Safe stringify: JSON.stringify never throws on valid JS values,
      // and we default to String() if it returns undefined (e.g. for
      // functions/symbols).
      const s = JSON.stringify(incoming)
      valueDesc = (typeof s === 'string' ? s : String(incoming)).slice(0, 120)
    }
    console.log(
      `[MAP_DATA_SANITIZER] source=${source} typeof=${typeof incoming} isArray=${isArray} value=${valueDesc}`
    )
    mapDataDebugLogged++
  }

  // 1. Forzar Parsing: whatever the server sent, coerce to an array.
  //    - null/undefined/"" → []
  //    - already an array → filter to point-shaped objects
  //    - a single object that looks like a point → [object]
  //    - a string that parses to an array → parsed array
  //    - anything else → []
  let raw: unknown[] = []
  if (incoming == null) {
    raw = []
  } else if (Array.isArray(incoming)) {
    raw = incoming
  } else if (typeof incoming === 'object') {
    // Single point object (has lat/lng) → wrap. Otherwise (e.g. a wrapper
    // envelope like {points: [...]}) → try to extract a known array field.
    const obj = incoming as Record<string, unknown>
    if ('lat' in obj || 'lng' in obj || 'latitude' in obj || 'longitude' in obj) {
      raw = [obj]
    } else if (Array.isArray(obj.points)) {
      raw = obj.points
    } else if (Array.isArray(obj.ghostrail_pts)) {
      raw = obj.ghostrail_pts
    } else if (Array.isArray(obj.pts)) {
      raw = obj.pts
    } else {
      raw = []
    }
  } else if (typeof incoming === 'string') {
    try {
      const parsed = JSON.parse(incoming)
      raw = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : [])
    } catch {
      raw = []
    }
  } else {
    raw = []
  }

  // 2. Filter to valid point-shaped objects. Tolerate field-name variants
  //    (lat/latitude, lng/longitude/lon). Drop anything that isn't a point.
  const out: { lat: number; lng: number; t?: string; zone?: string }[] = []
  for (const item of raw) {
    if (item == null || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const lat = (o.lat ?? o.latitude) as unknown
    const lng = (o.lng ?? o.lon ?? o.longitude) as unknown
    if (typeof lat !== 'number' || typeof lng !== 'number') continue
    if (!isFinite(lat) || !isFinite(lng)) continue
    // Tolerate timestamp field-name variants: t | ts | timestamp.
    const tRaw = o.t ?? o.ts ?? o.timestamp
    out.push({
      lat,
      lng,
      t: typeof tRaw === 'string' ? tRaw : undefined,
      zone: typeof o.zone === 'string' ? o.zone : undefined,
    })
  }
  return out
}

// ══════════════════════════════════════════════════════════════════
// URL SYNC + ZOOM PERSISTENCE
// PRIORITY: localStorage > URL params > default (16)
// localStorage key: stracker_map_zoom
// ══════════════════════════════════════════════════════════════════
const ZOOM_STORAGE_KEY = 'stracker_map_zoom'
const DEFAULT_ZOOM = 16
const DEFAULT_LAT = -31.64693
const DEFAULT_LNG = -60.71598

// LOGIC_02 (stracker_v5.2_rev): persist last known valid position so that
// when the backend reports "Sin ubicacion" (lat/lng null), we can flyTo
// the last saved location instead of showing an empty map.
const LAST_POS_STORAGE_KEY = 'stracker_last_pos'
function saveLastPosition(lat: number, lng: number) {
  try {
    localStorage.setItem(LAST_POS_STORAGE_KEY, JSON.stringify({ lat, lng, t: Date.now() }))
  } catch { /* localStorage unavailable */ }
}
function loadLastPosition(): { lat: number; lng: number } | null {
  try {
    const raw = localStorage.getItem(LAST_POS_STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng)) {
      return { lat: p.lat, lng: p.lng }
    }
  } catch { /* corrupt */ }
  return null
}

function readPersistedZoom(): number {
  if (typeof window === 'undefined') return DEFAULT_ZOOM
  // Priority 1: localStorage (user's last zoom)
  try {
    const stored = localStorage.getItem(ZOOM_STORAGE_KEY)
    if (stored) {
      const z = parseInt(stored, 10)
      if (z >= 1 && z <= 22) return z
    }
  } catch { /* ignore */ }
  // Priority 2: URL params
  try {
    const params = new URLSearchParams(window.location.search)
    const zoom = parseInt(params.get('zoom') || '', 10)
    if (zoom >= 1 && zoom <= 22) return zoom
  } catch { /* ignore */ }
  // Priority 3: default
  return DEFAULT_ZOOM
}

function readUrlParams(): { lat: number; lng: number; zoom: number } {
  if (typeof window === 'undefined') return { lat: DEFAULT_LAT, lng: DEFAULT_LNG, zoom: DEFAULT_ZOOM }
  try {
    const params = new URLSearchParams(window.location.search)
    const lat = parseFloat(params.get('lat') || '')
    const lng = parseFloat(params.get('lng') || '')
    return {
      lat: isFinite(lat) ? lat : DEFAULT_LAT,
      lng: isFinite(lng) ? lng : DEFAULT_LNG,
      // Use persisted zoom (localStorage > URL > default)
      zoom: readPersistedZoom(),
    }
  } catch {
    return { lat: DEFAULT_LAT, lng: DEFAULT_LNG, zoom: readPersistedZoom() }
  }
}

function writeUrlParams(lat: number, lng: number, zoom: number) {
  if (typeof window === 'undefined') return
  try {
    const url = new URL(window.location.href)
    url.searchParams.set('lat', lat.toFixed(5))
    url.searchParams.set('lng', lng.toFixed(5))
    url.searchParams.set('zoom', String(zoom))
    window.history.replaceState({}, '', url.toString())
  } catch { /* ignore */ }
}

// ══════════════════════════════════════════════════════════════════
// ACCORDION SECTION — for VER MÁS
// ══════════════════════════════════════════════════════════════════
function AccordionSection({
  title, isOpen, onToggle, children,
}: {
  title: string; isOpen: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div className="border-t border-white/[.04]">
      <button
        className="w-full flex items-center justify-between py-2 px-1 text-left"
        onClick={onToggle}
      >
        <span className="font-bold uppercase tracking-[0.2em] text-white/25" style={{ fontSize: 'clamp(8px, 1.7vw, 9px)' }}>{title}</span>
        <span
          className="text-white/20 transition-transform duration-200"
          style={{ fontSize: 10, transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-flex', transition: 'transform 150ms ease' }}
        >
          <ChevronRight size={12} strokeWidth={2.5} />
        </span>
      </button>
      {isOpen && <div className="pb-2">{children}</div>}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// MOVEMENT PIPELINE V2 — M1+M2: DEFINITIVE ENGINE
// States: SLEEP(sleep) | STILL(still) | WALK(walk) | BUS(bus) | CAR(car)
// Rules:
//   - NEVER show NONI just because speed=0
//   - still = person still but NOT sleeping
//   - sleep NONI = ONLY when high confidence of actual sleep
//   - Use speed, acceleration, GPS changes and context
//   - Maintain last valid state when confidence is low
// ══════════════════════════════════════════════════════════════════

function inferMovementFromSpeed(speedKmh: number | null): {
  mode: 'STILL' | 'WALK' | 'BUS' | 'CAR' | null
  confidence: number
} {
  if (speedKmh === null || speedKmh < 0) return { mode: null, confidence: 0 }
  if (speedKmh < 0.5) return { mode: 'STILL', confidence: 85 }
  if (speedKmh <= 7) return { mode: 'WALK', confidence: 90 }
  if (speedKmh <= 40) return { mode: 'BUS', confidence: 85 }
  return { mode: 'CAR', confidence: 90 }
}

// ── M1: SLEEP INFERENCE ENGINE ──
// sleep NONI appears ONLY when multiple sleep signals converge.
// Required confidence: 85%. Minimum duration: 45 min.
// Signals: screen_off_prolonged, no_movement, no_network_changes,
//          nocturnal_hours, no_interaction
function inferSleepState(pyState: any): {
  isSleeping: boolean
  confidence: number
  signals: string[]
} {
  const signals: string[] = []
  let confidence = 0

  // ── SIGNAL 1: Screen off for prolonged time ──
  const screenOffSec = pyState?.data_recovery?.screen_off_duration_sec ?? 0
  const screenOnSec = pyState?.data_recovery?.screen_on_duration_sec ?? 0
  const isScreenOff = !pyState?.device?.screen_on
    && (pyState?.device?.screen_state === 'OFF' || pyState?.device?.screen_state === 'off'
      || pyState?.device?.screen_on === false || pyState?.device?.screen_on === 0)

  if (screenOffSec >= 2700) { // 45 min
    signals.push('screen_off_prolonged')
    confidence += 30
  } else if (screenOffSec >= 1800) { // 30 min
    signals.push('screen_off_extended')
    confidence += 20
  } else if (isScreenOff && screenOffSec >= 900) { // 15 min
    signals.push('screen_off')
    confidence += 10
  }

  // ── SIGNAL 2: No movement ──
  const speedKmh = pyState?.movement?.speed_kmh ?? 0
  const movementMode = (pyState?.movement?.mode || '').toUpperCase()
  const isNoMovement = speedKmh < 0.5
    && (movementMode === 'STILL' || movementMode === 'STATIC' || movementMode === '' || movementMode === 'UNKNOWN')

  if (isNoMovement && screenOffSec >= 2700) {
    signals.push('sin_movimiento')
    confidence += 20
  } else if (isNoMovement) {
    signals.push('sin_movimiento_parcial')
    confidence += 8
  }

  // ── SIGNAL 3: No network changes ──
  const networkType = (pyState?.network?.type || '').toUpperCase()
  const isWifi = networkType.includes('WIFI')
  // Being on WiFi at home with no movement + screen off = strong sleep signal
  if (isWifi && isNoMovement && screenOffSec >= 1800) {
    signals.push('sin_cambios_de_red')
    confidence += 15
  }

  // ── SIGNAL 4: Nocturnal hours (22:00 - 06:00 Argentina time) ──
  const currentHour = new Date().getHours()
  const isNightTime = currentHour >= 22 || currentHour < 6
  if (isNightTime) {
    signals.push('horario_nocturno')
    confidence += 20
  }

  // ── SIGNAL 5: No interaction (screen on time is 0 or very low) ──
  if (screenOnSec === 0 && screenOffSec > 0) {
    signals.push('sin_interaccion')
    confidence += 15
  } else if (screenOnSec > 0 && screenOffSec > 0 && (screenOffSec / (screenOnSec + screenOffSec)) > 0.95) {
    signals.push('minima_interaccion')
    confidence += 8
  }

  // ── FINAL DETERMINATION ──
  // M1: Sleep requires >= 85% confidence + minimum 45 min screen off OR nocturnal + other signals
  const meetsMinimumDuration = screenOffSec >= 2700 // 45 min
  const isSleeping = confidence >= 85 && (meetsMinimumDuration || (isNightTime && confidence >= 85))

  return { isSleeping, confidence: Math.min(100, confidence), signals }
}

function deriveMovementMode(pyState: any, lastValidMode: string | null): {
  mode: string
  displayMode: string  // full label for VER MÁS
  icon: string         // token resolved by resolveMovementIcon() at render
  speedKmh: number | null
  speedLabel: string   // "20.0 km/h" for pin popup
  compactLabel: string // compact value text for HUD ribbon
  compactValue: string // "20km" value part for MetricBadge
  compactIcon: string  // token resolved by resolveMovementIcon() at render
  isActive: boolean
  inferredMode: string // the final inferred mode (for state tracking)
} {
  const rawMode = pyState?.movement?.mode || ''
  const upper = rawMode.toUpperCase()
  const speedKmh = pyState?.movement?.speed_kmh ?? null

  // M1: Sleep inference — check FIRST, before any speed-based logic
  const sleepState = inferSleepState(pyState)

  // Speed-based inference
  const speedInference = inferMovementFromSpeed(speedKmh)

  // Backend mode classification
  let backendMode: 'STILL' | 'WALK' | 'BUS' | 'CAR' | 'UNKNOWN' = 'UNKNOWN'
  if (upper === 'WALK' || upper === 'A PIE' || upper === 'ON_FOOT') backendMode = 'WALK'
  else if (upper === 'IN_VEHICLE' || upper === 'EN AUTO' || upper === 'CAR') backendMode = 'CAR'
  else if (upper === 'BUS' || upper === 'EN COLECTIVO') backendMode = 'BUS'
  else if (upper === 'ON_BICYCLE' || upper === 'BICYCLE') backendMode = 'WALK' // bicycle ~= walk speed
  else if (upper === 'STILL' || upper === 'STATIC') backendMode = 'STILL'

  // M1+M2: Decision fusion with sleep/still separation
  let finalMode: string
  if (sleepState.isSleeping) {
    // M1: SLEEP — only when high confidence of actual sleep
    finalMode = 'SLEEP'
  } else if (speedInference.mode && speedInference.confidence >= 85 && speedInference.mode !== 'STILL') {
    // Speed is reliable AND indicates movement — use it as primary classifier
    finalMode = speedInference.mode
  } else if (speedInference.mode === 'STILL' && speedInference.confidence >= 85) {
    // M1: Speed=0 -> STILL, NOT SLEEP/NONI
    finalMode = 'STILL'
  } else if (backendMode !== 'UNKNOWN' && backendMode !== 'STILL') {
    // Backend mode exists and indicates movement
    finalMode = backendMode
  } else if (backendMode === 'STILL') {
    // M1: Backend says still -> STILL, NOT SLEEP/NONI
    finalMode = 'STILL'
  } else if (lastValidMode && lastValidMode !== 'STILL' && lastValidMode !== 'SLEEP') {
    // M2 FALLBACK: prefer last known valid MOVEMENT mode
    finalMode = lastValidMode
  } else {
    // Default: STILL, never NONI just because speed=0
    finalMode = 'STILL'
  }

  // Map finalMode to display — FIX_3: tokens replace emojis
  let displayMode = 'QUIETA'
  let icon = 'still'
  let compactIcon = 'still'
  let isActive = false

  if (finalMode === 'SLEEP') {
    displayMode = 'DORMIDA'
    icon = 'sleep'
    compactIcon = 'sleep'
    isActive = false
  } else if (finalMode === 'STILL') {
    displayMode = 'QUIETA'
    icon = 'still'
    compactIcon = 'still'
    isActive = false
  } else if (finalMode === 'WALK') {
    displayMode = 'A PIE'
    icon = 'walk'
    compactIcon = 'walk'
    isActive = true
  } else if (finalMode === 'CAR') {
    displayMode = 'EN AUTO'
    icon = 'car'
    compactIcon = 'car'
    isActive = true
  } else if (finalMode === 'BUS') {
    displayMode = 'EN COLECTIVO'
    icon = 'bus'
    compactIcon = 'bus'
    isActive = true
  }

  // Speed label
  let speedLabel = ''
  let compactValue = ''
  if (finalMode === 'SLEEP') {
    speedLabel = ''
    compactValue = 'NONI'
  } else if (finalMode === 'STILL') {
    speedLabel = '0 km/h'
    compactValue = ''
  } else if (speedKmh !== null && speedKmh > 0) {
    speedLabel = `${speedKmh.toFixed(1)} km/h`
    compactValue = `${Math.round(speedKmh)}km`
  } else if (lastValidMode && lastValidMode !== 'STILL' && lastValidMode !== 'SLEEP') {
    compactValue = '···'
  }

  const compactLabel = `${compactIcon}${compactValue}`

  return { mode: rawMode, displayMode, icon, speedKmh, speedLabel, compactLabel, compactValue, compactIcon, isActive, inferredMode: finalMode }
}

// ══════════════════════════════════════════════════════════════════
// SCREEN STATE HELPER — F6: MULTI-SIGNAL INFERENCE WITH CONFIDENCE
// Direct source: device.screen_on (often unreliable)
// Inferred sources: movement, speed, network bursts, location updates,
//   battery discharge, WhatsApp activity proxy, foreground activity
// Rule: If user actively using WhatsApp, screen cannot be OFF.
// Output: 📱ON · hace 3m / 📱OFF · hace 27m
// ══════════════════════════════════════════════════════════════════
function deriveScreenState(pyState: any, dataAgeMs: number = 0): {
  isOn: boolean
  label: string      // "📱ON · hace 3m" or "📱OFF · hace 27m"
  shortLabel: string  // "ON · 3m" or "OFF · 27m" for HUD badge
  icon: string       // 📱 (always phone icon)
  color: string      // monochrome white (V5.5)
  confidence: number  // 0-100 confidence score
  source: string     // "direct" | "inferred_movement" | "inferred_network" | etc.
  staleOverride: boolean  // V6.11: true if 3-min threshold triggered
} {
  // ── V6.11 PHASE 2: SCREEN_STATE_TRUTH_ENFORCEMENT ──
  // ZERO TOLERANCE for stale data presented as live activity.
  // If the payload is older than 3 minutes, we CANNOT claim "Pantalla ON"
  // — the screen state in the payload was true at capture time, but we
  // have no way to know if it's still true now. Display "DESCONOCIDO /
  // CACHÉ" and zero the confidence. This override is FINAL and runs
  // before any other signal logic.
  if (dataAgeMs > V611_STALE_SCREEN_MS) {
    const ageMin = Math.floor(dataAgeMs / 60000)
    return {
      isOn: false,
      label: `📱DESCONOCIDO · ${ageMin}m`,
      shortLabel: `DESC/${ageMin}m`,
      icon: '📱',
      color: 'rgba(255,255,255,.4)',
      confidence: 0,
      source: 'stale_data_v611',
      staleOverride: true,
    }
  }
  const rawState = pyState?.device?.screen_on ?? pyState?.screen_state ?? null
  let isOn = rawState === true || rawState === 'ON' || rawState === 'on' || rawState === 1
  let confidence = 50
  let source = 'direct'

  // ── SIGNAL 1: Movement detection ──
  const movementMode = (pyState?.movement?.mode || '').toUpperCase()
  const isMoving = !['', 'STATIC', 'STILL', 'UNKNOWN'].includes(movementMode)
  const speedKmh = pyState?.movement?.speed_kmh ?? 0
  const isSpeedActive = speedKmh > 2

  if (isMoving || isSpeedActive) {
    isOn = true
    confidence = 95
    source = 'inferred_movement'
  }

  // ── SIGNAL 2: Network + location activity (WhatsApp proxy) ──
  const networkType = pyState?.network?.type || ''
  const hasNetwork = networkType.length > 0
  const hasValidLocation = pyState?.location?.lat != null && pyState?.location?.lng != null

  if (!isOn && hasNetwork && hasValidLocation) {
    // Active network + location updates = likely screen ON (WhatsApp bg proxy)
    confidence = 70
    source = 'inferred_network'
    // If network is WIFI + location = very likely screen ON (home/work WiFi + phone use)
    if (networkType.toUpperCase().includes('WIFI')) {
      isOn = true
      confidence = 80
      source = 'inferred_wifi_location'
    }
  }

  // ── SIGNAL 3: Data recovery / session signals ──
  const hasDataRecovery = pyState?.data_recovery != null
  if (hasDataRecovery && !isOn) {
    const offDuration = pyState?.data_recovery?.screen_off_duration_sec ?? 0
    const onDuration = pyState?.data_recovery?.screen_on_duration_sec ?? 0
    // Contradiction: screen says OFF but on_duration > 0 = probably still ON
    if (onDuration > 0 && offDuration === 0) {
      isOn = true
      confidence = 75
      source = 'inferred_session_data'
    }
    // Getting data updates while "OFF" for very short time = likely ON
    if (offDuration > 0 && offDuration < 120 && hasValidLocation) {
      isOn = true
      confidence = 65
      source = 'inferred_recent_data'
    }
  }

  // ── SIGNAL 4: Battery discharge rate proxy ──
  const batteryPct = pyState?.device?.battery ?? null
  const isCharging = pyState?.device?.charging ?? false
  if (isCharging && !isOn) {
    // Charging + getting updates = likely screen ON (phone plugged in and being used)
    isOn = true
    confidence = 60
    source = 'inferred_charging'
  }

  // ── SIGNAL 5: Location update frequency ──
  // If we have fresh GPS data (location exists + network active), screen is likely ON
  if (!isOn && hasValidLocation && hasNetwork && hasDataRecovery) {
    const sessionTotal = pyState?.data_recovery?.session_total_time ?? 0
    if (sessionTotal > 0 && sessionTotal < 3600) {
      // Active session < 1hr with location + network = likely ON
      isOn = true
      confidence = 70
      source = 'inferred_active_session'
    }
  }

  // ── Derive duration from backend accumulators ──
  let durationSec: number | null = null
  if (isOn) {
    durationSec = pyState?.data_recovery?.screen_on_duration_sec
      ?? pyState?.device?.screen_since_sec
      ?? null
  } else {
    durationSec = pyState?.data_recovery?.screen_off_duration_sec
      ?? pyState?.device?.screen_since_sec
      ?? null
  }

  // Format: ON · 3m / OFF · 27m — if duration available
  let shortLabel: string
  if (durationSec !== null && durationSec > 0) {
    const durationMin = Math.round(durationSec / 60)
    shortLabel = isOn ? `ON · ${durationMin}m` : `OFF · ${durationMin}m`
  } else {
    shortLabel = isOn ? 'ON' : 'OFF'
  }

  const label = `📱${shortLabel}`

  return {
    isOn,
    label,
    shortLabel,
    icon: '📱',
    color: isOn ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)',
    confidence,
    source,
    staleOverride: false,
  }
}

// ══════════════════════════════════════════════════════════════════
// NETWORK HELPER — single clean line
// ══════════════════════════════════════════════════════════════════
function deriveNetwork(pyState: any): {
  type: string      // WIFI / 4G / OFFLINE
  icon: string      // 📶 📱 📵
  color: string
} {
  const raw = (pyState?.network?.type || '').toUpperCase()
  let type = 'OFFLINE'
  let icon = '📵'
  let color = 'rgba(255,255,255,.4)'

  if (raw.includes('WIFI')) {
    type = 'WIFI'
    icon = '📶'
    color = 'rgba(255,255,255,.85)'
  } else if (raw.includes('4G') || raw.includes('LTE') || raw.includes('MOBILE') || raw.includes('CELLULAR')) {
    type = '4G'
    icon = '📱'
    color = 'rgba(255,255,255,.7)'
  } else if (raw.includes('3G') || raw.includes('2G')) {
    type = raw.includes('3G') ? '3G' : '2G'
    icon = '📱'
    color = 'rgba(255,255,255,.7)'
  }

  return { type, icon, color }
}

// ══════════════════════════════════════════════════════════════════
// PLACE BADGE ENGINE — L1-L5: SEMANTIC LOCATION CLASSIFICATION
// Priority: 🏢Xm > 💃 > 💼 > 🏠 (only ONE shown)
// L2: Home — geofence <60m, stay >10min, confidence ≥90%
// L3: Work — geofence <80m, stay >10min, confidence ≥90%
// L4: Nightlife — known venues + night hours + stay >20min, confidence ≥80%
// L5: Building — height inference ≥85% confidence, ≥12m, not home/work
// ══════════════════════════════════════════════════════════════════

// ── KNOWN GEOFENCES ──
// Home: Mariano Comas 3159 (from user's data)
const HOME_GEOFENCE = { lat: -31.64693, lng: -60.71598, radiusM: 60, minStayMin: 10 }

// Work: approximate typical work location (can be overridden by backend)
const WORK_GEOFENCE = { lat: -31.63700, lng: -60.70600, radiusM: 80, minStayMin: 10 }

// Nightlife venues in the area
const NIGHTLIFE_VENUES = [
  { name: 'HUB', lat: -31.64300, lng: -60.71200, radiusM: 80 },
  { name: 'SHEIK', lat: -31.64100, lng: -60.70900, radiusM: 80 },
  { name: 'ANTRO', lat: -31.63900, lng: -60.70700, radiusM: 80 },
  { name: 'LA GRIETA', lat: -31.64400, lng: -60.71000, radiusM: 80 },
]

// Haversine distance in meters
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

type PlaceBadgeType = 'HOME' | 'WORK' | 'NIGHTLIFE' | 'BUILDING' | null

interface PlaceBadge {
  type: PlaceBadgeType
  icon: string         // 🏠 / 💼 / 💃 / 🏢
  value: string        // "" / "18m" / "24m"
  color: string
  confidence: number
  source: string       // detection source description
}

function derivePlaceBadge(pyState: any): PlaceBadge {
  const lat = pyState?.location?.lat ?? null
  const lng = pyState?.location?.lng ?? null

  if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) {
    return { type: null, icon: '', value: '', color: 'rgba(255,255,255,.4)', confidence: 0, source: 'no_location' }
  }

  // ── Stay duration from data_recovery ──
  const sessionTotalSec = pyState?.data_recovery?.session_total_time ?? 0
  const stayDurationMin = sessionTotalSec / 60

  // ── Current hour for nightlife detection ──
  const currentHour = new Date().getHours()
  const isNightTime = currentHour >= 22 || currentHour < 5

  // ── L5: Building height inference ──
  // Uses altitude, vertical variation, time stability, urban density, OSM match
  const altitude = pyState?.gps?.altitude ?? pyState?.location?.altitude ?? null
  const altitudeAccuracy = pyState?.gps?.altitude_accuracy ?? pyState?.location?.altitude_accuracy ?? null
  const verticalVariation = pyState?.gps?.vertical_variation ?? 0
  const isStationary = (pyState?.movement?.speed_kmh ?? 0) < 0.5

  // Building confidence calculation
  let buildingConfidence = 0
  let estimatedHeightM: number | null = null

  if (altitude !== null && isFinite(altitude)) {
    // Ground level approximation for the area (~30m above sea level for Santa Fe)
    const GROUND_LEVEL_APPROX = 30
    const relativeAltitude = altitude - GROUND_LEVEL_APPROX

    // Only consider as building if relative altitude suggests a building (≥12m)
    if (relativeAltitude >= 12) {
      estimatedHeightM = Math.round(relativeAltitude)

      // Confidence factors
      // 1. Altitude accuracy (lower = better)
      const accuracyScore = altitudeAccuracy != null && altitudeAccuracy < 15 ? 30 : altitudeAccuracy != null && altitudeAccuracy < 30 ? 20 : 10

      // 2. Stationary (more stable = more likely in a building)
      const stationaryScore = isStationary ? 25 : 5

      // 3. Vertical variation (low variation = stable floor level)
      const stabilityScore = verticalVariation < 2 ? 25 : verticalVariation < 5 ? 15 : 5

      // 4. Height reasonableness (12-100m is typical building range)
      const heightScore = relativeAltitude >= 12 && relativeAltitude <= 100 ? 20 : relativeAltitude > 100 ? 5 : 0

      buildingConfidence = accuracyScore + stationaryScore + stabilityScore + heightScore
    }
  }

  // ── PRIORITY EVALUATION ──
  // 🏢 > 💃 > 💼 > 🏠

  // L5: BUILDING — show if confidence >= 85% and not at home/work
  if (buildingConfidence >= 85 && estimatedHeightM !== null && estimatedHeightM >= 12) {
    // Check not at home or work first
    const distToHome = haversineM(lat, lng, HOME_GEOFENCE.lat, HOME_GEOFENCE.lng)
    const distToWork = haversineM(lat, lng, WORK_GEOFENCE.lat, WORK_GEOFENCE.lng)
    if (distToHome > HOME_GEOFENCE.radiusM && distToWork > WORK_GEOFENCE.radiusM) {
      return {
        type: 'BUILDING',
        icon: '🏢',
        value: `${estimatedHeightM}m`,
        color: 'rgba(255,255,255,0.7)',
        confidence: buildingConfidence,
        source: `altitude_inference_${estimatedHeightM}m`,
      }
    }
  }

  // L4: NIGHTLIFE — known venues + night hours + stay >20min
  for (const venue of NIGHTLIFE_VENUES) {
    const dist = haversineM(lat, lng, venue.lat, venue.lng)
    if (dist < venue.radiusM) {
      let confidence = 60
      if (isNightTime) confidence += 25
      if (stayDurationMin > 20) confidence += 10
      if (confidence >= 80) {
        return {
          type: 'NIGHTLIFE',
          icon: '💃',
          value: '',
          color: 'rgba(255,255,255,0.85)',
          confidence,
          source: `nightlife_${venue.name}`,
        }
      }
    }
  }

  // L3: WORK — geofence <80m, stay >10min, confidence ≥90%
  const distToWork = haversineM(lat, lng, WORK_GEOFENCE.lat, WORK_GEOFENCE.lng)
  // Also check backend zone hint
  const backendZone = (pyState?.location?.zone || '').toUpperCase()
  const backendLabel = (pyState?.location?.label_primary || '').toUpperCase()
  if (distToWork < WORK_GEOFENCE.radiusM || backendZone === 'WORK' || backendLabel.includes('TRABAJO') || backendLabel.includes('WORK')) {
    let confidence = 75
    if (distToWork < WORK_GEOFENCE.radiusM) confidence += 10
    if (stayDurationMin > WORK_GEOFENCE.minStayMin) confidence += 10
    if (backendZone === 'WORK') confidence = Math.max(confidence, 92)
    if (confidence >= 90) {
      return {
        type: 'WORK',
        icon: '💼',
        value: '',
        color: 'rgba(255,255,255,0.85)',
        confidence,
        source: 'work_geofence',
      }
    }
  }

  // L2: HOME — geofence <60m, stay >10min, confidence ≥90%
  const distToHome = haversineM(lat, lng, HOME_GEOFENCE.lat, HOME_GEOFENCE.lng)
  if (distToHome < HOME_GEOFENCE.radiusM || backendZone === 'HOME' || pyState?.location?.is_home || backendLabel.includes('CASA') || backendLabel.includes('HOME')) {
    let confidence = 75
    if (distToHome < HOME_GEOFENCE.radiusM) confidence += 10
    if (stayDurationMin > HOME_GEOFENCE.minStayMin) confidence += 10
    if (backendZone === 'HOME' || pyState?.location?.is_home) confidence = Math.max(confidence, 95)
    if (confidence >= 90) {
      return {
        type: 'HOME',
        icon: '🏠',
        value: '',
        color: 'rgba(255,255,255,0.85)',
        confidence,
        source: 'home_geofence',
      }
    }
  }

  return { type: null, icon: '', value: '', color: 'rgba(255,255,255,.4)', confidence: 0, source: 'no_match' }
}

// ══════════════════════════════════════════════════════════════════
// MAIN — STRACKER Apple Maps Dark Minimalist
// Layout: FULL_SCREEN_MAP + FLOATING_GLASS_PANELS
// B2: Z-index hierarchy:
//   map pin: z-index 9999 (leaflet-marker-pane: 1200)
//   HUD: z-50 (above dropdown)
//   dropdown: z-30
//   zoom controls: z-20
//   miniblock: z-10 (fixed bottom)
// ══════════════════════════════════════════════════════════════════
export default function TrackerView() {
  const [snapshot, setSnapshot] = useState<SnapshotData | null>(null)
  const [events, setEvents] = useState<EventItem[]>([])
  const [showVerMas, setShowVerMas] = useState(false)
  const [mapReady, setMapReady] = useState(false)
  const [ghostVisible, setGhostVisible] = useState(true)
  const [followMode, setFollowMode] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const [wsConnected, setWsConnected] = useState(false)

  // ══════════════════════════════════════════════════════════════════
  // V6.11 PHASE 3: FORCE_LIVE_SYNC_PERSISTENCE
  // ══════════════════════════════════════════════════════════════════
  // `isLiveMode` MUST be `true` from component mount and stay true for
  // the entire session, without requiring the user to click any icon.
  // The audit tick forces a re-render whenever a new payload arrives so
  // the audited data (device label, screen state) is always reflected.
  // `deviceLabelV611` is the canonical label resolved from the Golden
  // Fingerprint — defaults to "Samsung A16" per user directive.
  // ══════════════════════════════════════════════════════════════════
  const [isLiveMode, setIsLiveMode] = useState<boolean>(true)
  const [v611AuditTick, setV611AuditTick] = useState<number>(0)
  const [deviceLabelV611, setDeviceLabelV611] = useState<string>('Samsung A16')
  const [v611PayloadAgeMs, setV611PayloadAgeMs] = useState<number>(0)
  const v611ForceRenderRef = useRef<number>(0)
  const [kernelSeq, setKernelSeq] = useState(0)
  const [snapshotVersion, setSnapshotVersion] = useState(0)
  const [isSatellite, setIsSatellite] = useState(false)
  const [cookiesRefreshing, setCookiesRefreshing] = useState(false)
  const [lastCookieRefresh, setLastCookieRefresh] = useState<string>('')
  // V5.8 SECURITY_FORTRESS: async-loaded encrypted cache points.
  // Loaded asynchronously on mount (crypto.subtle is async). Until loaded,
  // this is [] — the ghostrailPts memo treats empty cache as "no rescue data".
  const [cachedGhostPts, setCachedGhostPts] = useState<{ lat: number; lng: number; t?: string; zone?: string }[]>([])
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    gps: true, sesion: false, sistema: false, eventos: false, ghostrail: true, diagnostico: false,
  })
  const mapRef = useRef<any>(null)
  const mapInstanceRef = useRef<any>(null)
  const [mapInstanceReady, setMapInstanceReady] = useState(false)

  // ── SYS3 (Gemini directive): Smart Polling ──
  // Tracks the last time we received fresh data from ANY transport.
  // When fresh, HTTP polling is KILLED entirely (no setInterval).
  // A staleness timer re-arms polling after STALE_MS with no new data.
  const lastDataTsRef = useRef<number>(0)
  // LOGIC_GHOSTTRAIL_02 (stracker_core_ui): Signal Loss threshold = 60s.
  // No API response for >60s → declare OFFLINE (SIN SEÑAL) and re-arm polling.
  const STALE_MS = 60_000

  // V5.8 INFRA_REALTIME_SOCKETS: Socket.io connection ref.
  // The socket connects to the Realtime Gateway on port 3005 via the Caddy
  // gateway. When connected, location_update events replace HTTP polling.
  // If the socket disconnects, the existing HTTP polling fallback re-arms.
  const socketRef = useRef<Socket | null>(null)
  const [socketConnected, setSocketConnected] = useState(false)

  // ── MAGIA1: OSINT Time Scrubber ──
  // null = live (show current state). number = scrub to that GhostRail index.
  const [timeScrubIndex, setTimeScrubIndex] = useState<number | null>(null)
  const [scrubbing, setScrubbing] = useState(false)

  // ── MAGIA3: Haptic Heartbeat ── Track previous movement mode to detect transitions
  const prevMovementModeRef = useRef<string | null>(null)
  const prevSpoofLevelRef = useRef<SpoofLevel>('trusted')

  // ── MAGIA4: Drone Follow Mode ── Track last user map interaction (pan/zoom)
  const lastMapInteractionRef = useRef<number>(Date.now())
  const [droneMode, setDroneMode] = useState(false)
  const droneTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ── Fase 2: Forensic Export ──
  const [forensicCopied, setForensicCopied] = useState(false)

  // ── V8 HYPER-PREMIUM (stracker_v8_hyper_premium) ──
  // MC_8_03: DynamicIsland alert channel — replaces standalone Toast UI.
  // When non-null, the island expands elastically to surface the alert.
  const [islandAlert, setIslandAlert] = useState<IslandAlert | null>(null)
  // AT_2: heartbeat timestamp — bumped on every fresh payload arrival.
  // Drives the heartbeat-ring pulse on the DynamicIsland LED.
  const [heartbeatTs, setHeartbeatTs] = useState<number>(0)
  // AT_4: gesture occlusion — when the user pans/zooms the map, floating UI
  // dims to 0.25 opacity (via body class `map-gesture-active`). This ref
  // holds the debounce timer so rapid gestures don't thrash the class.
  const gestureOccludeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // MC_8_01: Pseudo-3D Drive Mode tilt factor [0..1]. 0 = flat (cenital),
  // 1 = full 32° perspective tilt. Engages when droneMode && speed > 40km/h.
  const [driveTilt, setDriveTilt] = useState<number>(0)
  // MC_8_02: circadian clock — ticks every 60s so MapStyleInyector re-renders.
  const [circadianNow, setCircadianNow] = useState<Date>(new Date())

  // ── ZOOM PERSISTENCE ──
  // Uses readPersistedZoom() which prioritizes: localStorage > URL > default
  const urlParams = useMemo(() => readUrlParams(), [])
  const persistedZoom = useMemo(() => readPersistedZoom(), [])
  const [userZoom, setUserZoom] = useState<number>(persistedZoom)
  const userZoomRef = useRef<number>(persistedZoom)

  // ── PIN CENTER LOCK ──
  const followModeRef = useRef<boolean>(true)
  const lastPinPosRef = useRef<{ lat: number; lng: number } | null>(null)

  // ── B4: MOVEMENT INFERENCE STATE ── Track last valid non-static mode
  const lastValidMovementRef = useRef<string | null>(null)

  // ── EARLY DERIVED STATE (moved here to avoid TDZ issues) ──
  // pyState, spoofResult, and movement must be declared BEFORE any hook
  // or function that might reference them (buildForensicPayload, drone mode, etc.)
  const pyState = snapshot?.state
  const spoofResult = mapSpoofFromBackend(snapshot)
  const movement = deriveMovementMode(pyState, lastValidMovementRef.current)
  // M2: Track last valid MOVEMENT mode (not STILL/SLEEP) for fallback
  if (movement.inferredMode && movement.inferredMode !== 'STILL' && movement.inferredMode !== 'SLEEP') {
    lastValidMovementRef.current = movement.inferredMode
  }

  // ── V7: GHOSTRAIL — SINGLE SOURCE CANONICAL, 24H STRICT ──
  // Source hierarchy: 1=live ghostrail_pts (from CSV via backend), 2=localStorage cache (rescue only)
  // EVERY point must have a valid timestamp within 24h. No exceptions.
  // No mixing sources without comparable timestamps. No invented points.
  // HOTFIX stracker_map_data_safety: the snapshot's ghostrail_pts is already
  // sanitized at ingestion (socket/poll), but we re-run sanitizePointsArray
  // here as the FINAL safety net before any data reaches the leaflet
  // renderers. Defense-in-depth: even if a future code path bypasses the
  // ingestion sanitizers (e.g. a stale snapshot restored from sessionStorage,
  // or a legacy cache), the map can never receive a non-array.
  // V10 REACT_LIFECYCLE_FIX: memoize rawGhostrailPts so it only changes when
  // snapshot?.ghostrail_pts reference changes. Without this, sanitizePointsArray
  // returns a NEW array every render → ghostrailPts useMemo recomputes every
  // render → [GHOSTRAIL_V7] log fired every 500ms (snapTick) → main thread flood.
  const rawGhostrailPts = useMemo(
    () => sanitizePointsArray(snapshot?.ghostrail_pts, 'memo.ghostrailPts.input'),
    [snapshot?.ghostrail_pts],
  )
  const ghostrailDiagnostics = useRef({ source: 'empty', live: 0, cache: 0, discarded_age: 0, discarded_no_ts: 0, discarded_dup: 0, total: 0 })
  const ghostrailPts = useMemo(() => {
    const now = Date.now()
    const cutoff24h = now - 24 * 60 * 60 * 1000
    const diag = { source: 'empty' as string, live: 0, cache: 0, discarded_age: 0, discarded_no_ts: 0, discarded_dup: 0, total: 0 }

    // ── VALIDATION: must have valid lat/lng and timestamp within 24h ──
    function isValid(p: any): p is { lat: number; lng: number; t: string; zone?: string } {
      if (p.lat == null || p.lng == null || !isFinite(p.lat) || !isFinite(p.lng)) return false
      if (!p.t || typeof p.t !== 'string') { diag.discarded_no_ts++; return false }
      const ts = new Date(p.t).getTime()
      if (!isFinite(ts)) { diag.discarded_no_ts++; return false }
      if (ts < cutoff24h) { diag.discarded_age++; return false }
      return true
    }

    // ── SPATIAL DEDUP: within ~5m ──
    function isNearExisting(p: { lat: number; lng: number }, existing: { lat: number; lng: number }[]): boolean {
      return existing.some(ep =>
        Math.abs(ep.lat - p.lat) < 0.00005 && Math.abs(ep.lng - p.lng) < 0.00005
      )
    }

    const canonical: { lat: number; lng: number; t: string; zone?: string; _src?: string }[] = []

    // ── SOURCE 1 (PRIMARY): Live ghostrail_pts from backend ──
    // These come from CSV (canonical), rebuilt every poll with timestamps.
    if (rawGhostrailPts.length > 0) {
      for (const p of rawGhostrailPts) {
        if (isValid(p)) {
          canonical.push({ lat: p.lat, lng: p.lng, t: p.t, zone: (p as any).zone, _src: 'live' })
          diag.live++
        }
      }
    }

    // ── SOURCE 2 (RESCUE ONLY): localStorage cache ──
    // Only used if Source 1 is empty (backend unreachable or no data).
    // Cache points must also have valid timestamps within 24h.
    // V5.8: cache is now AES-256-GCM encrypted, loaded async into cachedGhostPts.
    if (canonical.length === 0) {
      for (const cp of cachedGhostPts) {
        if (isValid(cp)) {
          canonical.push({ lat: cp.lat, lng: cp.lng, t: cp.t!, zone: (cp as any).zone, _src: 'cache' })
          diag.cache++
        }
      }
    }

    // ── Sort by timestamp ascending ──
    canonical.sort((a, b) => a.t.localeCompare(b.t))

    // ── Spatial dedup: remove consecutive points within 5m ──
    const deduped: typeof canonical = []
    for (const p of canonical) {
      if (!isNearExisting(p, deduped)) {
        deduped.push(p)
      } else {
        diag.discarded_dup++
      }
    }

    // ── Cache for rescue continuity ──
    if (deduped.length > 0) {
      cacheGhostrailPoints(deduped.map(({ _src, ...rest }) => rest))
    }

    diag.source = diag.live > 0 ? 'live' : diag.cache > 0 ? 'cache' : 'empty'
    diag.total = deduped.length
    ghostrailDiagnostics.current = diag

    // V10: [GHOSTRAIL_V7] console.log removed — was firing every render due to
    // unmemoized rawGhostrailPts. Diagnostics still available in ghostrailDiagnostics.current.

    return deduped
  }, [rawGhostrailPts, cachedGhostPts])

  const routedTrailPts = useRoutedTrail(ghostVisible ? ghostrailPts : [])

  // ── MAGIA1: OSINT Time Scrubber ── When scrubbing, filter GhostRail to
  // show only points up to the selected index. null = live (show all).
  // NOTE: Uses the same routedTrailPts (no second useRoutedTrail call to
  // avoid hook order complications). The scrubbed marker shows position.
  const scrubbedPts = useMemo(() => {
    if (timeScrubIndex === null || !scrubbing) return ghostrailPts
    const idx = Math.max(0, Math.min(timeScrubIndex, ghostrailPts.length - 1))
    return ghostrailPts.slice(0, idx + 1)
  }, [ghostrailPts, timeScrubIndex, scrubbing])

  // The point at the scrub index — marker "travels back in time" to here
  const scrubbedPoint = timeScrubIndex !== null && scrubbing && ghostrailPts.length > 0
    ? ghostrailPts[Math.min(timeScrubIndex, ghostrailPts.length - 1)]
    : null

  // ══════════════════════════════════════════════════════════════════
  // V5.7 NAV_02_HEADING_SYSTEM: compute heading via Math.atan2 with latch.
  // When speed < 1.5 km/h, the heading is frozen to prevent GPS jitter from
  // causing erratic icon rotation. The heading is computed from the last two
  // ghostrail points (or the last point + current position).
  // ══════════════════════════════════════════════════════════════════
  const prevHeadingRef = useRef<number | null>(null)
  const headingState: HeadingState = useMemo(() => {
    // When scrubbing, compute heading from the scrubbed slice (historical)
    const ptsForHeading = scrubbing && scrubbedPts.length > 0 ? scrubbedPts : ghostrailPts
    const curLat = scrubbing && scrubbedPoint ? scrubbedPoint.lat : (pyState?.location?.lat ?? null)
    const curLng = scrubbing && scrubbedPoint ? scrubbedPoint.lng : (pyState?.location?.lng ?? null)
    const speed = scrubbing ? null : (movement.speedKmh ?? null) // don't latch during scrub
    const result = computeHeading(
      ptsForHeading as NavGhostPoint[],
      curLat,
      curLng,
      speed,
      prevHeadingRef.current,
    )
    // Persist the heading for next render's latch logic
    if (result.heading != null) {
      prevHeadingRef.current = result.heading
    }
    return result
  }, [ghostrailPts, scrubbedPts, scrubbedPoint, scrubbing, pyState?.location?.lat, pyState?.location?.lng, movement.speedKmh])

  // ══════════════════════════════════════════════════════════════════
  // V9 PAYLOAD_HEADING_INJECTION: prefer heading/bearing/course from the
  // raw Google Location Sharing payload over the computed (atan2) heading.
  // The device-reported heading is authoritative when present. We scan
  // ghostrail_pts[0], points[0], and stats.current_heading in that order,
  // checking `heading`, `bearing`, and `course` fields (Google API variants).
  // When a valid 0-360 deg value is found, it overrides the computed heading
  // and the latch is released (Google's value is already device-smoothed).
  // When no payload heading exists, we fall back to headingState (computed).
  // Per V9 spec: if heading exists → rotate marker; if not → static point.
  // ══════════════════════════════════════════════════════════════════
  const payloadHeading = useMemo<number | null>(() => {
    const latestGhost = ghostrailPts[0] as any
    const latestPoint = snapshot?.points?.[0] as any
    const statsHeading = (snapshot as any)?.stats?.current_heading
    const candidates: any[] = [
      latestGhost?.heading,
      latestGhost?.bearing,
      latestGhost?.course,
      latestPoint?.heading,
      latestPoint?.bearing,
      latestPoint?.course,
      statsHeading,
    ]
    for (const c of candidates) {
      if (typeof c === 'number' && isFinite(c) && c >= 0 && c <= 360) {
        return c
      }
    }
    return null
  }, [ghostrailPts, snapshot?.points, snapshot])

  // V9: effective heading prefers the Google payload; falls back to computed.
  const effectiveHeading = payloadHeading != null ? payloadHeading : headingState.heading
  const effectiveHeadingLatch = payloadHeading != null ? false : headingState.latched

  // ══════════════════════════════════════════════════════════════════
  // V5.7 NAV_03_SNAP_TO_DOOR: when stationary > 5min, apply ~8m perpendicular
  // offset toward the "nearest sidewalk" (right-hand side of arrival vector).
  // Display-only — the underlying lat/lng data stays accurate. The marker
  // animates to the snapped position with cubic ease-out.
  // ══════════════════════════════════════════════════════════════════
  const prevSnapRef = useRef<SnapState | null>(null)
  const [snapTick, setSnapTick] = useState(0)
  // Tick every 500ms so the snap animation + stationary timer update smoothly
  useEffect(() => {
    const id = setInterval(() => setSnapTick(t => (t + 1) % 1000000), 500)
    return () => clearInterval(id)
  }, [])
  const snapState: SnapState = useMemo(() => {
    const curLat = pyState?.location?.lat ?? null
    const curLng = pyState?.location?.lng ?? null
    const result = computeSnapOffset(
      ghostrailPts as NavGhostPoint[],
      curLat,
      curLng,
      movement.speedKmh ?? null,
      prevSnapRef.current,
      Date.now(),
    )
    prevSnapRef.current = result
    return result
  }, [ghostrailPts, pyState?.location?.lat, pyState?.location?.lng, movement.speedKmh, snapTick])

  // ══════════════════════════════════════════════════════════════════
  // V6.0 stracker_fix_geospatial_drift — PROJECTION_CALIBRATION +
  // FORCED_MAP_SYNC + DEBUG_OVERLAY + snap_to_road.
  // ══════════════════════════════════════════════════════════════════
  // Pipeline (runs every render with fresh pyState):
  //   1. normalizeWgs84(): reject NaN, clamp lat, wrap lng, flag null-island.
  //   2. snapToRoad(): if GPS accuracy > 35m and the raw point is far from
  //      any ghostrail point, snap to the nearest trail point (display-only).
  //   3. getDisplayPosition(): apply the existing snap-to-door offset
  //      (NAV_03) on top of the calibrated coordinate.
  //   4. computeDriftReport(): measure raw→rendered drift; warn if > 50m.
  //   5. computeMapSyncAction(): if accuracy < 20m → fitBounds; if pin is
  //      > 50m from viewport center → panTo. The effect below fires the
  //      chosen action on the Leaflet map instance.
  // ══════════════════════════════════════════════════════════════════
  const driftDebugRef = useRef<{
    rawLat: number | null
    rawLng: number | null
    renderedLat: number | null
    renderedLng: number | null
    snapReason: string | null
    normalizedReason: string | null
    driftM: number
    exceedsThreshold: boolean
  }>({
    rawLat: null, rawLng: null, renderedLat: null, renderedLng: null,
    snapReason: null, normalizedReason: null, driftM: 0, exceedsThreshold: false,
  })
  const [driftTick, setDriftTick] = useState(0)
  useEffect(() => {
    // Tick every 2s so the drift report + map sync re-evaluate even when
    // the backend hasn't pushed a new position (catches viewport drift).
    const id = setInterval(() => setDriftTick(t => (t + 1) % 1000000), 2000)
    return () => clearInterval(id)
  }, [])

  // PROJECTION_CALIBRATION: normalize the raw backend coordinate.
  const normalizedPin = useMemo(() => {
    const rawLat = pyState?.location?.lat ?? null
    const rawLng = pyState?.location?.lng ?? null
    return normalizeWgs84(rawLat, rawLng)
  }, [pyState?.location?.lat, pyState?.location?.lng])

  // snap_to_road (emergency): if accuracy is poor, snap to nearest ghostrail pt.
  const roadSnapped = useMemo(() => {
    if (!normalizedPin) return { lat: null as number | null, lng: null as number | null, snapped: false, reason: null as string | null }
    const acc = pyState?.gps?.accuracy ?? pyState?.location?.accuracy ?? 0
    const r = snapToRoad(normalizedPin.lat, normalizedPin.lng, ghostrailPts as NavGhostPoint[], acc)
    return { lat: r.lat, lng: r.lng, snapped: r.snapped, reason: r.reason ?? null }
  }, [normalizedPin, ghostrailPts, pyState?.gps?.accuracy, pyState?.location?.accuracy])

  // Compute the final rendered pin position (after road snap + NAV_03 snap-to-door).
  const calibratedDisplayPos = useMemo(() => {
    if (!normalizedPin || roadSnapped.lat == null || roadSnapped.lng == null) return null
    // If road snap fired, use the snapped coord as the "real" input to the
    // NAV_03 door-snap interpolation. Otherwise use the normalized raw coord.
    const baseLat = roadSnapped.snapped ? roadSnapped.lat : normalizedPin.lat
    const baseLng = roadSnapped.snapped ? roadSnapped.lng : normalizedPin.lng
    return getDisplayPosition(baseLat, baseLng, snapState)
  }, [normalizedPin, roadSnapped, snapState])

  // DEBUG_OVERLAY: compute drift report and stash for the overlay renderer.
  useEffect(() => {
    if (!normalizedPin) return
    const map = mapInstanceRef.current
    const renderedLat = calibratedDisplayPos?.lat ?? normalizedPin.lat
    const renderedLng = calibratedDisplayPos?.lng ?? normalizedPin.lng
    let vpLat = renderedLat, vpLng = renderedLng
    if (map) {
      try {
        const c = map.getCenter()
        vpLat = c.lat
        vpLng = c.lng
      } catch { /* map not ready */ }
    }
    const acc = pyState?.gps?.accuracy ?? pyState?.location?.accuracy ?? 0
    const report = computeDriftReport(
      normalizedPin.lat, normalizedPin.lng,
      renderedLat, renderedLng,
      vpLat, vpLng,
      acc,
    )
    driftDebugRef.current = {
      rawLat: normalizedPin.lat,
      rawLng: normalizedPin.lng,
      renderedLat,
      renderedLng,
      snapReason: roadSnapped.snapped ? roadSnapped.reason : null,
      normalizedReason: normalizedPin.wasNormalized ? (normalizedPin.reason ?? 'normalized') : null,
      driftM: report.driftM,
      exceedsThreshold: report.exceedsThreshold,
    }
    // V10: [V6.0_DRIFT] console.warn/debug removed — was firing every 2s (driftTick).
    // Drift report still stored in driftDebugRef.current for DriftDebugMarker overlay.
  }, [normalizedPin, calibratedDisplayPos, roadSnapped, pyState?.gps?.accuracy, pyState?.location?.accuracy, driftTick])

  // FORCED_MAP_SYNC: fire fitBounds or panTo based on the drift report.
  // Cooldown: only fire if > 8s since last sync, to avoid competing with
  // the existing PIN CENTER LOCK effect (which pans on every snapshot).
  const lastMapSyncRef = useRef(0)
  useEffect(() => {
    const map = mapInstanceRef.current
    if (!map || !normalizedPin) return
    if (!followModeRef.current) return  // respect user pan
    const now = Date.now()
    if (now - lastMapSyncRef.current < 8000) return  // 8s cooldown
    const renderedLat = calibratedDisplayPos?.lat ?? normalizedPin.lat
    const renderedLng = calibratedDisplayPos?.lng ?? normalizedPin.lng
    let vpLat = renderedLat, vpLng = renderedLng
    try {
      const c = map.getCenter()
      vpLat = c.lat
      vpLng = c.lng
    } catch { /* ignore */ }
    const acc = pyState?.gps?.accuracy ?? pyState?.location?.accuracy ?? 0
    const action = computeMapSyncAction(renderedLat, renderedLng, vpLat, vpLng, acc)
    if (!action) return
    lastMapSyncRef.current = now
    if (action.kind === 'fitBounds') {
      try {
        // Preserve current zoom — fitBounds would zoom in too aggressively.
        const curZoom = map.getZoom()
        map.panTo([action.lat, action.lng], { animate: true, duration: 0.6 })
        map.setZoom(curZoom, { animate: true })
        // V10: [V6.0_MAP_SYNC] debug log removed.
      } catch { /* V10: fitBounds failure silently ignored — console purged */ }
    } else if (action.kind === 'panTo') {
      // Direct panTo (not panToWithOffset) — for forced re-sync, exact
      // centering is correct. panToWithOffset is declared later in the
      // component and isn't available in this effect's closure.
      try {
        map.panTo([action.lat, action.lng], { animate: true, duration: 0.6 })
      } catch { /* ignore */ }
      // V10: [V6.0_MAP_SYNC] debug log removed.
    }
  }, [normalizedPin, calibratedDisplayPos, pyState?.gps?.accuracy, pyState?.location?.accuracy, driftTick])

  // ── MAGIA2: Thermal Clusters of Detention (Loitering Heatmaps) ──
  // Algorithm: scan GhostRail chronologically. When consecutive points stay
  // within <15m for >10 minutes, mark the centroid as a loitering hotspot.
  // Returns array of { lat, lng, radius_m, duration_min, start_t, end_t }.
  const loiteringClusters = useMemo(() => {
    if (ghostrailPts.length < 2) return []
    const LOITER_DIST_M = 15      // <15m = "stayed put"
    const LOITER_TIME_MIN = 10    // for >10 min = "loitering"
    const LOITER_TIME_MS = LOITER_TIME_MIN * 60 * 1000

    const clusters: {
      lat: number; lng: number; radius_m: number
      duration_min: number; start_t: string; end_t: string; point_count: number
    }[] = []

    let groupStart = 0
    for (let i = 1; i <= ghostrailPts.length; i++) {
      const prev = ghostrailPts[i - 1]
      const cur = i < ghostrailPts.length ? ghostrailPts[i] : null
      // If next point is far away OR we reached the end, close the current group
      const farAway = cur
        ? Math.abs(cur.lat - prev.lat) * 111000 > LOITER_DIST_M ||
          Math.abs(cur.lng - prev.lng) * 85000 > LOITER_DIST_M
        : true

      if (farAway) {
        const group = ghostrailPts.slice(groupStart, i)
        if (group.length >= 2) {
          const t0 = new Date(group[0].t).getTime()
          const t1 = new Date(group[group.length - 1].t).getTime()
          const spanMs = t1 - t0
          if (spanMs >= LOITER_TIME_MS) {
            // Centroid of the group
            const avgLat = group.reduce((s, p) => s + p.lat, 0) / group.length
            const avgLng = group.reduce((s, p) => s + p.lng, 0) / group.length
            // Max drift within the group = radius
            let maxDrift = 5
            for (const p of group) {
              const dLat = (p.lat - avgLat) * 111000
              const dLng = (p.lng - avgLng) * 85000
              const d = Math.sqrt(dLat * dLat + dLng * dLng)
              if (d > maxDrift) maxDrift = d
            }
            clusters.push({
              lat: avgLat, lng: avgLng,
              radius_m: Math.max(15, Math.min(80, maxDrift + 10)),
              duration_min: Math.round(spanMs / 60000),
              start_t: group[0].t, end_t: group[group.length - 1].t,
              point_count: group.length,
            })
          }
        }
        groupStart = i
      }
    }
    return clusters
  }, [ghostrailPts])

  // ── URL SYNC ──
  const urlSyncTimerRef = useRef<NodeJS.Timeout | null>(null)

  // B2: Dynamic dropdown height — compute safe max-height to avoid pin overlap
  const [dropdownMaxH, setDropdownMaxH] = useState<string>('40vh')
  const miniblockRef = useRef<HTMLDivElement>(null)
  // V8: Track mobile viewport for bottom offset (110px on mobile so panel never covers pin)
  // V8 SHORT_VIEWPORT: on very short screens (iPhone SE, landscape) use smaller bottom offset
  // V9: Add isTablet breakpoint (768-1024) for max-width 440px
  const [isMobile, setIsMobile] = useState(false)
  const [isTablet, setIsTablet] = useState(false)
  const [isShortViewport, setIsShortViewport] = useState(false)
  // V9: track cookies block expand state to invalidate leaflet size after expand/collapse
  const [cookiesExpanded, setCookiesExpanded] = useState(false)
  // V6.1 cookie_restore — drawer persistente de acceso rápido (z-50 overlay)
  const [cookieDrawerOpen, setCookieDrawerOpen] = useState(false)

  // ── T3 (Gemini roast): TrackerSheet snap state + progress for backdrop blur ──
  const [sheetSnap, setSheetSnap] = useState<'closed' | 'half' | 'full'>('half')
  const [sheetProgress, setSheetProgress] = useState(0)
  // V9: external snap control — when 📋 opens VER MÁS, expand sheet to 'half' on mobile
  const [externalSheetSnap, setExternalSheetSnap] = useState<'closed' | 'half' | 'full' | null>(null)

  // ── V11 UI_REDESIGN_MOBILE_FIRST: Bottom Sheet expand state ──
  // collapsed = ~22vh (≤25-30% per spec, never covers central crosshair/pin)
  // expanded = ~55vh (full telemetry + forensic + diagnostics)
  const [sheetExpanded, setSheetExpanded] = useState<boolean>(false)

  // V9: when VER MÁS toggles, control sheet snap on mobile (desktop is always open panel)
  // FIX_2 (stracker_hotfix_ui_v8.2): cuando VER MÁS está cerrado (default),
  // el sheet va a 'half' (NO 'closed'). Antes se forzaba a 'closed' (38px =
  // solo drag handle), haciendo el tablero invisible hasta que el usuario
  // arrastrara. Ahora el tablero minimalista es visible por defecto.
  useEffect(() => {
    if (!isMobile) {
      setExternalSheetSnap(null)
      return
    }
    if (showVerMas) {
      setExternalSheetSnap('half')
    } else {
      setExternalSheetSnap('half')
    }
  }, [showVerMas, isMobile])

  // T3: pin offset on desktop — shift pin right so left floating panel doesn't crowd it.
  // Panel is 380px wide + 16px margin = 396px. Half = 198px offset.
  const PIN_OFFSET_X = isMobile ? 0 : 192

  // V9 COMPACT HEIGHT-AWARE: compute safe dropdown height using spec budgets.
  // Height budget (collapsed panel): desktop 180px / mobile 170px / tiny 140px.
  // Pin safety: panel NEVER covers viewport center (pin at vh/2).
  // When VER MÁS expands, dropdown grows within (maxPanelHeight - baseHeight).
  // On tiny viewports, VER MÁS is hidden and cookies force-collapsed.
  useEffect(() => {
    const computeSafeHeight = () => {
      const vh = window.innerHeight
      const vw = window.innerWidth
      const mobile = vw < 768
      const short = vw < 360 || vh < 600
      // V9 spec height budgets (collapsed panel max)
      const panelBudget = short ? 140 : (mobile ? 170 : 180)
      // Pin safety: panel must not extend above vh/2 - safety_margin
      const bottomOffset = short ? 60 : (mobile ? 80 : 40)
      const maxPanelHeight = Math.min(panelBudget, Math.max(80, vh / 2 - bottomOffset - 10))
      // V9 base height — Estado(30) + Botonera(40/44) + Cookies(34) + VER MÁS(32) + paddings
      // tiny: Estado(30) + Botonera(44) + Cookies(34) + no VER MÁS = ~108 + paddings ≈ 120
      let baseHeight = short ? 120 : (mobile ? 150 : 146)
      // V9: measure actual base height at runtime (sum non-dropdown children)
      if (miniblockRef.current) {
        try {
          const card = miniblockRef.current.querySelector(':scope > div')
          if (card) {
            let measured = 0
            for (const child of Array.from(card.children)) {
              const cls = (child.className || '') + ''
              if (cls.includes('overflow-y-auto') && cls.includes('border-t')) continue
              measured += child.getBoundingClientRect().height
            }
            if (measured > 0) baseHeight = measured
          }
        } catch {}
      }
      const maxDrawerH = maxPanelHeight - baseHeight
      // VER MÁS dropdown can grow up to maxDrawerH, but also cap by viewport fraction
      const clamped = Math.max(40, Math.min(maxDrawerH, short ? vh * 0.10 : (mobile ? vh * 0.15 : vh * 0.25)))
      setDropdownMaxH(`${Math.round(clamped)}px`)
    }
    // Compute immediately + after a short delay (let DOM settle after viewport change)
    computeSafeHeight()
    const t = setTimeout(computeSafeHeight, 100)
    const onResize = () => {
      computeSafeHeight()
      // V8: invalidateSize after resize so map repaints correctly
      if (mapInstanceRef.current) {
        try { mapInstanceRef.current.invalidateSize() } catch {}
      }
    }
    window.addEventListener('resize', onResize)
    return () => {
      clearTimeout(t)
      window.removeEventListener('resize', onResize)
    }
  }, [showVerMas, cookiesExpanded, isMobile, isTablet, isShortViewport])

  // V8: Track viewport breakpoint on mount + resize (independent of showVerMas)
  // V9: Also track tablet breakpoint
  useEffect(() => {
    const check = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      setIsMobile(w < 768)
      setIsTablet(w >= 768 && w < 1024)
      setIsShortViewport(w < 360 || h < 600)
    }
    check()
    const onResize = () => {
      check()
      if (mapInstanceRef.current) {
        try { mapInstanceRef.current.invalidateSize() } catch {}
      }
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // V8: invalidateSize when VER MÁS toggles (panel height changes → map must repaint)
  useEffect(() => {
    if (!mapInstanceRef.current) return
    const t = setTimeout(() => {
      try { mapInstanceRef.current.invalidateSize() } catch {}
    }, 250)
    return () => clearTimeout(t)
  }, [showVerMas])

  // V9: invalidateSize when cookies block expands/collapses (panel height changes → map must repaint)
  useEffect(() => {
    if (!mapInstanceRef.current) return
    const t = setTimeout(() => {
      try { mapInstanceRef.current.invalidateSize() } catch {}
    }, 180)
    return () => clearTimeout(t)
  }, [cookiesExpanded])

  // T3 (Gemini roast): invalidateSize when TrackerSheet snap changes (panel height changes → map repaint)
  useEffect(() => {
    if (!mapInstanceRef.current) return
    const t = setTimeout(() => {
      try { mapInstanceRef.current.invalidateSize() } catch {}
    }, 320) // sheet spring transition ~300ms
    return () => clearTimeout(t)
  }, [sheetSnap, isMobile])

  // Z-index fix + Leaflet CSS
  useEffect(() => {
    if (typeof window !== 'undefined') {
      // Leaflet CSS
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'
      document.head.appendChild(link)

      // Global styles
      const style = document.createElement('style')
      style.id = 'stracker-global-styles'
      if (!document.getElementById('stracker-global-styles')) {
        style.textContent = `
          @keyframes spoofPulse {
            0% { box-shadow: inset 0 0 60px 10px rgba(255,255,255,.03); }
            50% { box-shadow: inset 0 0 160px 40px rgba(255,255,255,.06); }
            100% { box-shadow: inset 0 0 60px 10px rgba(255,255,255,.03); }
          }
          @keyframes signalPulse {
            0% { box-shadow: inset 0 0 60px 10px rgba(255,255,255,.02); }
            50% { box-shadow: inset 0 0 160px 40px rgba(255,255,255,.04); }
            100% { box-shadow: inset 0 0 60px 10px rgba(255,255,255,.02); }
          }
          @keyframes verMasPulse {
            0% { opacity: 0.3; box-shadow: 0 0 4px rgba(255,255,255,.1); }
            50% { opacity: 1; box-shadow: 0 0 10px rgba(255,255,255,.25); }
            100% { opacity: 0.3; box-shadow: 0 0 4px rgba(255,255,255,.1); }
          }
          /* V9: 150ms expand animation for cookies block + ver_mas accordion */
          @keyframes cookiesExpand {
            from { opacity: 0; transform: translateY(-4px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes verMasExpand {
            from { opacity: 0; max-height: 0; }
            to { opacity: 1; max-height: var(--vermas-maxh, 40vh); }
          }
          @keyframes cookieKeyPulse {
            0%, 100% { opacity: .5; transform: scale(1); }
            50% { opacity: 0; transform: scale(1.15); }
          }
          .leaflet-container { background: #0b0f14 !important; }
          .leaflet-control-zoom { display: none !important; }
          .pb-safe { padding-bottom: env(safe-area-inset-bottom, 0px); }
          .overflow-y-auto::-webkit-scrollbar { width: 0; height: 0; }
          /* B2: Z-index hierarchy — map pin always above UI */
          .leaflet-marker-pane { z-index: 9999 !important; }
          .leaflet-overlay-pane { z-index: 400 !important; }
          .leaflet-tile-pane { z-index: 100 !important; }
          /* T5 magic #1: tile-pane blur synced with sheet progress (pin stays crisp) */
          .leaflet-tile-pane {
            filter: blur(var(--map-tile-blur, 0px)) brightness(var(--map-tile-brightness, 1));
            transition: filter 300ms ease;
          }
          /* B3: Horizontal scroll metrics bar — hide scrollbar */
          .metrics-scroll::-webkit-scrollbar { display: none; }
          .metrics-scroll { -ms-overflow-style: none; scrollbar-width: none; }
        `
        document.head.appendChild(style)
      }

      requestAnimationFrame(() => setMapReady(true))
    }
  }, [])

  // ── SYS3 (Gemini directive): Smart Polling — short-circuit when fresh ──
  // When data is fresh (received within STALE_MS), HTTP polling is KILLED
  // entirely (no setInterval runs). A staleness timer fires at STALE_MS to
  // flip wsConnected → false, which re-arms the 3s polling fallback.
  // Each successful fetch resets lastDataTsRef, extending the fresh window.
  // This eliminates redundant HTTP requests on Render free tier while
  // guaranteeing recovery if the data source goes silent.
  // INFRA_01 (stracker_v5.3_integration): bootstrap session on mount. Reads
  // localStorage (long-term) → validates/refreshes the token (or mints a new
  // one). This is what keeps the user "logged in" after F5: the token is
  // restored from localStorage before the first poll fires, so every
  // subsequent fetchWithAuth carries a valid Bearer header.
  useEffect(() => {
    ensureSession()
    // INTEL_01: request push-notification permission once on dashboard load.
    // The Bell icon in AnalyticsPanel reflects the resulting state and offers
    // a secondary request path on click. Safe to call repeatedly.
    requestNotificationPermission()

    // V5.8 SECURITY_FORTRESS: Load encrypted ghostrail cache on mount.
    // The cache is AES-256-GCM encrypted at rest. Decryption is async
    // (Web Crypto API). Once loaded, the ghostrailPts memo picks it up
    // as SOURCE 2 (rescue) if no live data is available.
    loadCachedGhostrailPoints().then(pts => {
      if (pts.length > 0) setCachedGhostPts(pts)
    })
  }, [])

  // V5.8 INFRA_REALTIME_SOCKETS: WebSocket connection to Realtime Gateway.
  // Replaces client-side HTTP polling with server-pushed location_update events.
  // The socket connects via the Caddy gateway: io("/?XTransformPort=3005").
  //
  // Connection lifecycle:
  //   1. On mount, attempt to connect to the gateway.
  //   2. On `location_update` event, update snapshot + mark fresh (kills HTTP polling).
  //   3. On disconnect, the existing HTTP polling fallback re-arms automatically
  //      (because wsConnected flips to false when no fresh data arrives).
  //   4. On unmount, disconnect the socket cleanly.
  //
  // WEBSOCKET_RESET (stracker_v6_emergency_repair): In PRODUCTION (Render),
  // there is no realtime-gateway deployed — tracker_map.py is HTTP-only
  // (SimpleHTTPRequestHandler, no WebSocket support). The XTransformPort
  // mechanism is a Caddy-gateway feature that doesn't exist on Render. So
  // attempting the socket connection in production produces repeated failed
  // wss attempts in the console (image_3cdba5.png) with no benefit.
  //
  // Fix: detect the production hostname and SKIP socket creation entirely.
  // The app falls back to HTTP polling (fetchWithAuth → /points), which is
  // fully functional and delivers 8+ points per poll. The fallback_mode
  // directive (force transports:['polling']) is effectively already satisfied
  // because we skip the socket altogether — cleaner than polling a
  // nonexistent socket.io server.
  useEffect(() => {
    if (typeof window === 'undefined') return

    // PRODUCTION GATEWAY DETECTION: if we're on the Render domain (or any
    // non-localhost production host), there's no socket.io gateway deployed.
    // Skip socket creation — HTTP polling handles data delivery.
    const hostname = window.location.hostname
    const isProduction = hostname.includes('onrender.com') ||
                         hostname.includes('render.com') ||
                         hostname.includes('onfireweb.app') ||
                         (hostname !== 'localhost' && hostname !== '127.0.0.1' && !hostname.startsWith('192.168.') && !hostname.startsWith('10.'))

    if (isProduction) {
      // No gateway in production — log once and rely on HTTP polling.
      // The Smart Polling system (SYS3) handles data delivery: it polls
      // /points every 3s when data is stale, and kills polling when fresh.
      // V10: [V5.8_SOCKET] production log removed — console must stay clean.
      setSocketConnected(false)
      return // Skip socket creation entirely
    }

    let socket: Socket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    function connect() {
      try {
        socket = createSocket('/?XTransformPort=3005', {
          // v6.1 emergency_repair (AUDIT_WEBSOCKET_HANDSHAKE) — allow polling
          // → websocket upgrade (the socket.io default). WS-only transport
          // fails behind the Caddy reverse proxy because the initial HTTP
          // handshake (which negotiates the SID) needs polling first, then
          // upgrades to WebSocket. This is the recommended setup behind any
          // reverse proxy (Caddy, nginx, etc.).
          //
          // fallback_mode (stracker_v6_emergency_repair): if wss keeps
          // failing, the polling transport keeps working. We don't force
          // ['polling'] only because the dual transport already degrades
          // gracefully — polling succeeds even if wss upgrade fails.
          transports: ['polling', 'websocket'],
          reconnection: true,
          reconnectionAttempts: 3,
          reconnectionDelay: 2000,
          reconnectionDelayMax: 8000,
          timeout: 4000,
        })

        socket.on('connect', () => {
          setSocketConnected(true)
          // V10: [V5.8_SOCKET] connected log removed.
        })

        socket.on('location_update', (data: any) => {
          // Same transformation as the HTTP poll response
          try {
            // HOTFIX stracker_map_data_safety: Forzar Parsing. The backend
            // can emit ghostrail_pts as a single object, null, or a wrapped
            // envelope. sanitizePointsArray() coerces any of these to a
            // clean array of point-shaped objects before they reach the map.
            const rawGhostrailPts = data?.ghostrail_pts ?? data?.state?.ghostrail?.points_24h ?? []
            const ghostrailPtsData = sanitizePointsArray(rawGhostrailPts, 'socket.location_update.ghostrail_pts')
            const pointsData = sanitizePointsArray(data?.points, 'socket.location_update.points')

            const transformed: SnapshotData = {
              points: pointsData,
              state: data?.state ?? null,
              ghostrail_pts: ghostrailPtsData,
              _meta: {
                tick: 0,
                event_seq: data?._meta?.event_seq || 0,
                snapshot_version: data?._meta?.snapshot_version || 1,
                architecture: data?.state?.meta?.engine || 'PYTHON_TRACKER',
              },
            }
            setSnapshot(transformed)
            lastDataTsRef.current = Date.now()
            setWsConnected(true)
            setHeartbeatTs(Date.now())
            if (transformed._meta.event_seq) setKernelSeq(transformed._meta.event_seq)
            if (transformed._meta.snapshot_version) setSnapshotVersion(transformed._meta.snapshot_version)
          } catch (err) {
            console.error('[V5.8_SOCKET] location_update parse error:', err)
          }
        })

        socket.on('disconnect', (reason) => {
          setSocketConnected(false)
          // V10: [V5.8_SOCKET] disconnected log removed.
          // The HTTP polling fallback will re-arm automatically because
          // wsConnected flips to false when lastDataTsRef becomes stale.
        })

        socket.on('connect_error', (err) => {
          setSocketConnected(false)
          // V10: [V5.8_SOCKET] connect_error warn removed — falling back to HTTP polling is expected behavior.
          // The HTTP polling fallback handles data delivery.
        })
      } catch (err) {
        console.error('[V5.8_SOCKET] Failed to create socket:', err)
      }
    }

    connect()
    socketRef.current = socket

    return () => {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (socket) {
        socket.removeAllListeners()
        socket.disconnect()
      }
      socketRef.current = null
    }
  }, [])

  // INTEL_01: Reactive notification engine. Diffs prev vs next state on every
  // successful poll and fires alerts on transitions (estado_anterior !=
  // estado_nuevo). The prevAlertRef holds the baseline; evaluateAlerts
  // applies the 30-min cooldown per alert type internally.
  const prevAlertRef = useRef<AlertState | null>(null)
  useEffect(() => {
    if (!snapshot || !pyState) return
    // Compute current alert state from the same store the map uses.
    const speedKmh = movement?.speedKmh ?? pyState?.movement?.speed_kmh ?? 0
    const lat = pyState?.location?.lat ?? null
    const lng = pyState?.location?.lng ?? null
    let insideGeofence: boolean | null = null
    let unknownSpotSince: number | null = null
    if (lat != null && lng != null) {
      // reuse the geofence calc: distance to home
      const d = haversineM(lat, lng, HOME_GEOFENCE.lat, HOME_GEOFENCE.lng)
      const insideHome = d < HOME_GEOFENCE.radiusM
      const dWork = haversineM(lat, lng, WORK_GEOFENCE.lat, WORK_GEOFENCE.lng)
      const insideWork = dWork < WORK_GEOFENCE.radiusM
      const insideKnown = insideHome || insideWork
      insideGeofence = insideHome
      // STAGNATION: at an unknown spot — track when this state began.
      if (!insideKnown) {
        if (prevAlertRef.current?.unknownSpotSince != null) {
          unknownSpotSince = prevAlertRef.current.unknownSpotSince
        } else {
          unknownSpotSince = Date.now()
        }
      }
    }
    const next: AlertState = { insideGeofence, avgSpeedKmh: speedKmh, unknownSpotSince }
    evaluateAlerts(prevAlertRef.current, next, { homeRadiusM: HOME_GEOFENCE.radiusM })
    prevAlertRef.current = next
  }, [snapshot, pyState, movement])

  // ── V11 TELEMETRY_LIFECYCLE_PURGE: /points polling useEffect ──
  // AUDIT: Every setInterval/setTimeout is cleared in a single cleanup return.
  // No anonymous timers escape. Deps = [isLiveMode, wsConnected] (minimal).
  // When isLiveMode === false, the effect returns immediately — zero timers,
  // zero fetches, zero memory pressure. V6.11 logic inside poll() preserved.
  useEffect(() => {
    // V11: Live mode gate. When paused, ALL polling stops. The last snapshot
    // is preserved. (V6.11 re-enables isLiveMode on fresh payload, so this
    // gate only blocks polling during a deliberate user pause.)
    if (!isLiveMode) return

    let intervalId: ReturnType<typeof setInterval> | null = null
    let staleTimerId: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        // LOGIC_GHOSTTRAIL_02: explicit 24h time window (1440 min) injected as
        // start/end query params. Backend enforces the same 24h cutoff; these
        // params make the temporal contract declarative and future-proof.
        // INFRA_01 (stracker_v5.3_integration): fetchWithAuth injects the
        // Bearer token (localStorage-backed) and validates the session before
        // each call — refresh loop. Survives F5 without re-authentication.
        const endTs = Date.now()
        const startTs = endTs - 24 * 60 * 60 * 1000 // NOW() - 24h
        const resp = await fetchWithAuth(`/points?start=${startTs}&end=${endTs}`)
        if (resp.ok) {
          const data = await resp.json()
          // V7: ghostrail_pts comes from CSV (canonical). Prefer top-level (already transformed),
          // fallback to state.ghostrail.points_24h (raw from Python).
          // HOTFIX stracker_map_data_safety: Forzar Parsing — sanitize the
          // raw response so a non-array (single object, null, wrapped
          // envelope) is coerced to a clean array before reaching the map.
          const rawGhostrailPts = data.ghostrail_pts ?? data.state?.ghostrail?.points_24h ?? []
          const ghostrailPtsData = sanitizePointsArray(rawGhostrailPts, 'http.poll.ghostrail_pts')
          const pointsData = sanitizePointsArray(data.points, 'http.poll.points')

          const transformed: SnapshotData = {
            points: pointsData,
            state: data.state || null,
            ghostrail_pts: ghostrailPtsData,
            _meta: {
              tick: 0,
              event_seq: data._meta?.event_seq || 0,
              snapshot_version: data._meta?.snapshot_version || 1,
              architecture: data.state?.meta?.engine || 'PYTHON_TRACKER',
            },
          }
          setSnapshot(transformed)
          // SYS3: mark fresh data — this keeps polling KILLED until stale
          lastDataTsRef.current = Date.now()
          setWsConnected(true)
          // AT_2 (stracker_v8_hyper_premium): heartbeat — bump on every fresh
          // payload arrival so the DynamicIsland LED replays its heartbeat ring.
          setHeartbeatTs(Date.now())
          if (transformed._meta.event_seq) setKernelSeq(transformed._meta.event_seq)
          if (transformed._meta.snapshot_version) setSnapshotVersion(transformed._meta.snapshot_version)

          // ── V6.11 PHASE 1: LIVE_TELEMETRY_SNAPSHOT ──
          // Capture the Golden Fingerprint from the live payload and lock
          // it as the canonical signature for "Samsung A16". Then resolve
          // the device label and update the HUD. Also compute the payload
          // age so Phase 2 (screen state truth enforcement) can fire.
          const v611Age = computePayloadAgeMs(data)
          const v611Fp = captureGoldenFingerprint(data)
          const v611Label = resolveDeviceLabel(data)
          setDeviceLabelV611(v611Label)
          setV611PayloadAgeMs(v611Age)
          // V6.11 Phase 3: force re-render with audited data. The audit
          // tick is a state bump that triggers React to re-render the
          // entire component, ensuring the latest fingerprint + age +
          // label are reflected in the HUD.
          v611ForceRenderRef.current += 1
          setV611AuditTick(v611ForceRenderRef.current)
          // V6.11: enforce isLiveMode = true on every fresh payload —
          // no event, no user gesture, no socket glitch can disable it.
          if (!isLiveMode) setIsLiveMode(true)
          // V6.11: append forensic audit entry for post-mortem analysis.
          appendV611AuditLog({
            ts: Date.now(),
            ageMs: v611Age,
            fingerprint: v611Fp.fingerprint,
            matched: v611Fp.matched,
            screenDecision: v611Age > V611_STALE_SCREEN_MS ? 'STALE_OVERRIDE' : 'live',
            rawToken: data?.device_label || null,
          })
          return
        }
      } catch (e) { console.error('[V10] /points fetch failed:', e) }

      setWsConnected(false)
    }

    // SYS3: if data is fresh, DON'T poll at all — just set a staleness timer.
    // The timer re-arms polling (wsConnected→false) if no new data arrives.
    if (wsConnected) {
      const remaining = STALE_MS - (Date.now() - lastDataTsRef.current)
      const delay = remaining > 1000 ? remaining : 1000
      staleTimerId = setTimeout(() => {
        // No fresh data for STALE_MS → declare stale, re-arm polling
        setWsConnected(false)
      }, delay)
    } else {
      // Disconnected (stale) → poll aggressively every 3s until fresh data arrives
      poll()
      intervalId = setInterval(poll, 3000)
    }

    // V11 SURGICAL CLEANUP: both timers are cleared on unmount OR dep change.
    // Single exit point — no timer can leak across renders.
    return () => {
      if (intervalId) clearInterval(intervalId)
      if (staleTimerId) clearTimeout(staleTimerId)
    }
  }, [isLiveMode, wsConnected])

  // ── T3: panToWithOffset ── Centers the pin with a horizontal pixel offset
  // so the pin sits in the VISIBLE center (right of the left desktop panel),
  // not the raw viewport center. On mobile, offset = 0 (no left panel).
  // Uses map.latLngToContainerPoint / containerPointToLatLng (instance methods,
  // no global L needed). Preserves zoom.
  const panToWithOffset = useCallback((lat: number, lng: number, opts?: { animate?: boolean; duration?: number }) => {
    const map = mapInstanceRef.current
    if (!map) return
    if (PIN_OFFSET_X === 0) {
      map.panTo([lat, lng], opts || { animate: true, duration: 0.8 })
      return
    }
    // Desktop: compute the lat/lng that sits PIN_OFFSET_X pixels LEFT of the
    // target pin. Centering on THAT lat/lng makes the pin appear PIN_OFFSET_X
    // pixels RIGHT of viewport center (clear of the left floating panel).
    try {
      const targetPoint = map.latLngToContainerPoint([lat, lng] as any)
      const offsetLatLng = map.containerPointToLatLng([targetPoint.x - PIN_OFFSET_X, targetPoint.y] as any)
      map.panTo(offsetLatLng, opts || { animate: true, duration: 0.8 })
    } catch {
      map.panTo([lat, lng], opts || { animate: true, duration: 0.8 })
    }
  }, [PIN_OFFSET_X])

  // ── PIN CENTER LOCK ── Pan to new position WITHOUT changing zoom
  // Uses panToWithOffset() to center on pin while preserving zoom + desktop offset
  useEffect(() => {
    if (!mapInstanceRef.current || !snapshot?.state) return
    const state = snapshot.state
    const lat = state.ui?.map?.lat ?? state.location?.lat
    const lng = state.ui?.map?.lng ?? state.location?.lng
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return

    if (!followModeRef.current) return

    const newPos = { lat, lng }
    const lastPos = lastPinPosRef.current
    if (lastPos && lastPos.lat === newPos.lat && lastPos.lng === newPos.lng) return

    lastPinPosRef.current = newPos
    const currentZoom = mapInstanceRef.current.getZoom()
    panToWithOffset(lat, lng, { animate: true, duration: 0.8 })
    writeUrlParams(lat, lng, currentZoom)
  }, [snapshot, panToWithOffset])

  // ── ZOOM PERSISTENCE ── Save zoom to localStorage on every zoom change
  // CRITICAL: Depends on mapInstanceReady, not just mapReady
  // mapReady means the map container can render, but mapInstanceReady means
  // the Leaflet map instance is actually available for event binding
  useEffect(() => {
    if (!mapInstanceRef.current) return
    const map = mapInstanceRef.current

    const onZoomEnd = () => {
      const z = map.getZoom()
      userZoomRef.current = z
      setUserZoom(z)
      // Persist to localStorage immediately
      try { localStorage.setItem(ZOOM_STORAGE_KEY, String(z)) } catch { /* ignore */ }
      const center = map.getCenter()
      writeUrlParams(center.lat, center.lng, z)
    }

    map.on('zoomend', onZoomEnd)
    return () => { map.off('zoomend', onZoomEnd) }
  }, [mapInstanceReady])

  // ── URL SYNC ── moveend with debounce
  // Also depends on mapInstanceReady for the same reason as zoom persistence
  useEffect(() => {
    if (!mapInstanceRef.current) return
    const map = mapInstanceRef.current

    const onMoveEnd = () => {
      const center = map.getCenter()
      const zoom = map.getZoom()
      if (urlSyncTimerRef.current) clearTimeout(urlSyncTimerRef.current)
      urlSyncTimerRef.current = setTimeout(() => {
        writeUrlParams(center.lat, center.lng, zoom)
      }, 300)
    }

    map.on('moveend', onMoveEnd)
    return () => { map.off('moveend', onMoveEnd) }
  }, [mapInstanceReady])

  // ── Restore zoom from localStorage on mount (already handled by readPersistedZoom in initial state)
  // This is a safety net: if the MapContainer renders before the ref is populated,
  // we explicitly set the zoom when the map instance is ready
  useEffect(() => {
    try {
      const stored = localStorage.getItem(ZOOM_STORAGE_KEY)
      if (stored) {
        const z = parseInt(stored, 10)
        if (z >= 1 && z <= 22 && z !== userZoomRef.current) {
          userZoomRef.current = z
          requestAnimationFrame(() => setUserZoom(z))
        }
      }
    } catch { /* ignore */ }
  }, [])

  // ── V8: DynamicIsland alert router (replaces standalone Toast UI) ──
  // showToast now classifies the message and pushes an IslandAlert, which
  // the DynamicIsland renders as an expanded pill. Auto-dismisses after the
  // island's internal timeout. The old `toast` state is kept as a no-op
  // fallback so existing call sites (forensic export, etc.) still compile.
  const showToast = useCallback((msg: string) => {
    // Classify by content heuristics
    const upper = msg.toUpperCase()
    let kind: IslandAlert['kind'] = 'info'
    if (upper.includes('SPOOF') || upper.includes('🛑') || upper.includes('ALERTA') || upper.includes('ERROR')) {
      kind = msg.includes('⚠️') ? 'warning' : 'critical'
    } else if (upper.includes('⚠️') || upper.includes('STALE') || upper.includes('SIN SEÑAL')) {
      kind = 'warning'
    }
    setIslandAlert({ kind, msg })
  }, [])

  // Backward-compat: keep setToast wired so any stray direct calls don't crash.
  // (The standalone toast JSX is removed in favor of DynamicIsland.)
  useEffect(() => {
    if (toast) {
      // Mirror legacy toast into the island, then clear
      showToast(toast)
      setToast(null)
    }
  }, [toast, showToast])

  // Auto-toast
  useEffect(() => {
    if (events.length === 0) return
    const latest = events[events.length - 1]
    if (latest.type === 'ARRIVAL_PROGRESS' || latest.type === 'ZONE_CHANGE') {
      const p = latest.payload
      const msg = latest.type === 'ARRIVAL_PROGRESS'
        ? (p.to_stage === 'ARRIVED' ? '🏠 LLEGÓ A CASA' : `📍 LLEGANDO ${p.distance_m}m`)
        : `🗺️ ${p.from_label} → ${p.to_label}`
      requestAnimationFrame(() => showToast(msg))
      // T5 magic #3: Web Haptics — vibrate on zone change / arrival (mobile only)
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(latest.type === 'ARRIVAL_PROGRESS' && p.to_stage === 'ARRIVED' ? [20, 40, 20, 40, 30] : [15, 30, 15])
      }
    }
    // T5 #3: stronger haptic on spoof red alert — also push a CRITICAL island alert
    if (latest.type === 'SPOOF_DETECTED') {
      const p = latest.payload || {}
      requestAnimationFrame(() => showToast(`⚠️ ALERTA: ${p.signal || 'Salto de señal GPS detectado'} (Spoofing)`))
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([30, 50, 30, 50, 30, 50, 60])
      }
    }
  }, [events, showToast])

  // ── F7: AUTO URL REFRESH AND RECENTER — every 25 seconds ──
  // Keeps URL synchronized with live position + recenters on pin
  // NEVER resets zoom — always uses panTo to preserve user's zoom level
  useEffect(() => {
    const interval = setInterval(() => {
      if (!mapInstanceRef.current || !snapshot?.state) return
      const state = snapshot.state
      const lat = state.ui?.map?.lat ?? state.location?.lat
      const lng = state.ui?.map?.lng ?? state.location?.lng
      if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return

      // Recenter on pin — panToWithOffset preserves zoom + desktop offset
      if (followModeRef.current) {
        panToWithOffset(lat, lng, { animate: true, duration: 0.5 })
      }

      // Sync URL with current position + zoom
      const currentZoom = mapInstanceRef.current.getZoom()
      writeUrlParams(lat, lng, currentZoom)
    }, 25000)

    return () => clearInterval(interval)
  }, [snapshot, panToWithOffset])

  // Center camera — uses panToWithOffset to preserve zoom + apply desktop pin offset
  const centerCamera = useCallback(() => {
    if (!mapInstanceRef.current || !snapshot?.state) return
    const state = snapshot.state
    const lat = state.ui?.map?.lat ?? state.location?.lat
    const lng = state.ui?.map?.lng ?? state.location?.lng
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return
    // panToWithOffset preserves zoom + shifts pin right on desktop (clear of left panel)
    panToWithOffset(lat, lng, { animate: true })
    setFollowMode(true)
    followModeRef.current = true
    const currentZoom = mapInstanceRef.current.getZoom()
    writeUrlParams(lat, lng, currentZoom)
  }, [snapshot, panToWithOffset])

  // Cookies refresh
  // V8 LEGACY_CODE_ERADICATION: refreshCookies used to POST /api/deploy
  // which 404s in production. The function was never invoked from the UI
  // (dead code), but we keep the stub so any reference resolves to a
  // safe no-op instead of a network call.
  const refreshCookies = useCallback(async () => {
    setCookiesRefreshing(true)
    try {
      // No-op: /api/deploy endpoint does not exist in the Python backend.
      // Simulate success so the UI toast still fires harmlessly.
      await new Promise(r => setTimeout(r, 100))
      setLastCookieRefresh(new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }))
      showToast('Cookies gestionadas vía backend')
    } finally {
      setCookiesRefreshing(false)
    }
  }, [showToast])

  // ── DERIVED STATE ── (pyState, spoofResult, movement already declared above)
  const ui = snapshot?.state?.ui

  // LOGIC_02 (stracker_v5.2_rev): fallback chain ahora prefiere la última
  // posición guardada en localStorage antes que el HOME_GEOFENCE estático.
  // Orden: ui.map > pyState.location > URL params > localStorage(last) > HOME_GEOFENCE
  const lastSavedPos = typeof window !== 'undefined' ? loadLastPosition() : null
  const mapLat = ui?.map?.lat ?? pyState?.location?.lat ?? urlParams.lat ?? lastSavedPos?.lat ?? HOME_GEOFENCE.lat
  const mapLng = ui?.map?.lng ?? pyState?.location?.lng ?? urlParams.lng ?? lastSavedPos?.lng ?? HOME_GEOFENCE.lng

  // LOGIC_02: persistir posición válida del backend para futuras sesiones
  useEffect(() => {
    const validLat = pyState?.location?.lat
    const validLng = pyState?.location?.lng
    if (validLat != null && validLng != null && isFinite(validLat) && isFinite(validLng)) {
      saveLastPosition(validLat, validLng)
    }
  }, [pyState?.location?.lat, pyState?.location?.lng])

  // V6.11 Phase 2: pass the payload age to deriveScreenState so the
  // 3-minute stale override fires. We read the age from state (refreshed
  // by the poll loop on every fresh payload).
  const screen = deriveScreenState(pyState, v611PayloadAgeMs)
  const network = deriveNetwork(pyState)
  const placeBadge = derivePlaceBadge(pyState)
  const locationLabel = pyState?.location?.label_primary || ''

  // ── MAGIA3 (Gemini directive): Haptic Heartbeat ──
  // Fires navigator.vibrate on critical STATE transitions detected from
  // snapshot: movement mode change (Estacionado→En ruta) and spoof level
  // escalation. Must run AFTER movement + spoofResult are derived.
  useEffect(() => {
    if (!snapshot?.state) return
    const canVibrate = typeof navigator !== 'undefined' && !!navigator.vibrate
    if (!canVibrate) return

    // 1) Movement mode transition (e.g. STILL → IN_VEHICLE, "Estacionado" → "En ruta")
    const currentMode = movement.inferredMode || null
    const prevMode = prevMovementModeRef.current
    if (prevMode !== null && currentMode !== null && prevMode !== currentMode) {
      const becameActive = currentMode !== 'STILL' && currentMode !== 'SLEEP'
      const wasInactive = prevMode === 'STILL' || prevMode === 'SLEEP'
      if (becameActive && wasInactive) {
        // Target started moving — double pulse
        navigator.vibrate([20, 50, 20])
      } else if (!becameActive && wasInactive === false) {
        // Target stopped — single soft pulse
        navigator.vibrate(15)
      }
    }
    if (currentMode !== null) prevMovementModeRef.current = currentMode

    // 2) Spoof level escalation (trusted → warning → suspicious → spoof_detected)
    const currentSpoof = spoofResult.level
    const prevSpoof = prevSpoofLevelRef.current
    const severityOrder: SpoofLevel[] = ['trusted', 'warning', 'suspicious', 'spoof_detected']
    if (severityOrder.indexOf(currentSpoof) > severityOrder.indexOf(prevSpoof)) {
      // Spoof risk INCREASED — urgent heartbeat
      navigator.vibrate([30, 40, 30, 40, 60])
    }
    prevSpoofLevelRef.current = currentSpoof
  }, [snapshot, movement.inferredMode, spoofResult.level])

  // FIX_1 (stracker_hotfix_ui_v8.2): Coordenadas fallback Santa Fe para
  // depuración visual. Cuando el backend reporta "Sin ubicacion" (lat/lng
  // null), el LiveMarker no renderizaba y el usuario veía un mapa vacío.
  // Ahora usamos el HOME_GEOFENCE como fallback para que el pin SIEMPRE
  // aparezca (criterio_1 de la matriz de verificación v8.2).
  const FALLBACK_LAT = HOME_GEOFENCE.lat // -31.64693 (Santa Fe, AR)
  const FALLBACK_LNG = HOME_GEOFENCE.lng // -60.71598

  const mapData = ui?.map || (pyState?.location && pyState.location.lat != null && pyState.location.lng != null ? {
    lat: pyState.location.lat,
    lng: pyState.location.lng,
    lat_str: String(pyState.location.lat.toFixed(5)),
    lng_str: String(pyState.location.lng.toFixed(5)),
    show_speed: movement.speedKmh !== null && movement.speedKmh > 0,
    speed_label: movement.speedLabel,
    mode: movement.mode,
    is_home: pyState.location?.zone === 'HOME',
    auto_unlock_camera: true,
  } : {
    // FIX_1: fallback estático — pin siempre visible para depuración
    lat: FALLBACK_LAT,
    lng: FALLBACK_LNG,
    lat_str: String(FALLBACK_LAT.toFixed(5)),
    lng_str: String(FALLBACK_LNG.toFixed(5)),
    show_speed: false,
    speed_label: '',
    mode: 'STILL',
    is_home: true,
    auto_unlock_camera: true,
  })

  const centerLat = mapLat
  const centerLng = mapLng

  // GPS quality — V9: text labels ALTA/MEDIA/BAJA (spec: 📡ALTA)
  const gpsAccuracy = pyState?.gps?.accuracy ?? pyState?.location?.accuracy ?? 0
  const gpsQuality = gpsAccuracy <= 20 ? 'ALTA' : gpsAccuracy <= 60 ? 'MEDIA' : 'BAJA'
  const gpsColor = 'rgba(255,255,255,.8)'

  // Battery — M5: ultra-compact format (🔋15, 🔋52, 🔋100). No ⚡, no %, no spaces
  const batteryPct = pyState?.device?.battery ?? null
  const batteryLabel = batteryPct !== null ? `${batteryPct}` : ''

  // Ver más data
  const verMasGps = ui?.ver_mas?.gps ?? (pyState ? {
    place: pyState.location?.label_primary || '---',
    lat: pyState.location?.lat ?? null,
    lat_str: pyState.location?.lat?.toFixed(5) || '---',
    lng: pyState.location?.lng ?? null,
    lng_str: pyState.location?.lng?.toFixed(5) || '---',
    accuracy: pyState.gps?.status || '---',
    signal: pyState.network?.quality || '---',
  } : undefined)

  const verMasSession = ui?.ver_mas?.session ?? (pyState?.data_recovery ? {
    duration: `${Math.round((pyState.data_recovery.session_total_time || 0) / 60)}m`,
    screen_on: `${Math.round((pyState.data_recovery.screen_on_duration_sec || 0) / 60)}m`,
    screen_off: `${Math.round((pyState.data_recovery.screen_off_duration_sec || 0) / 60)}m`,
  } : undefined)

  const verMasSystem = ui?.ver_mas?.system ?? (pyState ? {
    network: network.type,
    battery_raw: batteryLabel || '---',
    motion_raw: movement.displayMode,
  } : undefined)

  const verMasEvents = ui?.ver_mas?.events ?? (pyState?.events?.length ? pyState.events.map((e: any) => ({
    msg: e.msg,
    color: e.type === 'SPOOF_DETECTED' ? 'rgba(255,255,255,.95)' : e.type === 'BATTERY_LOW' ? 'rgba(255,255,255,.7)' : e.type === 'ZONE_CHANGE' ? 'rgba(255,255,255,.8)' : 'rgba(255,255,255,.4)',
  })) : undefined)

  const verMasGhostrail = ui?.ver_mas?.ghostrail ?? (pyState?.ghostrail?.last_24h_zones?.length ? pyState.ghostrail.last_24h_zones.map((z: any) => ({
    name: z.name,
    duration: `${z.min || '?'}min`,
    color: 'rgba(255,255,255,.7)',
  })) : undefined)

  const overlays = ui?.overlays ?? { spoof: spoofResult.level === 'spoof_detected', signal: spoofResult.level === 'suspicious', alert_loop: false }

  const toggleSection = useCallback((key: string) => {
    setOpenSections(prev => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // B2: Determine which sections to compress when dropdown needs space
  const compressSections = showVerMas && dropdownMaxH !== '40vh'

  // ── Fase 2 (Gemini directive): Forensic Telemetry Exporter ──
  // Builds a structured JSON payload for Gemini OSINT analysis, copies it
  // to clipboard with haptic feedback, and offers download as .json file.
  // Payload: metadata + vector_primario + OSRM route analysis + GhostRail
  // context (last 20 critical points) + embedded analyst instruction.
  // NOTE: Not wrapped in useCallback to avoid TDZ issues with deps array.
  const buildForensicPayload = async () => {
    const HOME_TARGET: [number, number] = [-31.64693, -60.71598] // HOME_ZONE_CENTER from backend

    const lat = mapData?.lat ?? mapLat
    const lng = mapData?.lng ?? mapLng
    const speed = movement?.speedKmh ?? null
    const heading = pyState?.gps?.heading ?? pyState?.location?.heading ?? null
    const accuracy = gpsAccuracy
    const battery = batteryPct

    // OSRM route analysis to home target (distance + ETA)
    let routeAnalysis: Record<string, any> = {
      distancia_restante_metros: null,
      eta_segundos: null,
      desvio_trayectoria: false,
      destino: { lat: HOME_TARGET[0], lng: HOME_TARGET[1], label: 'HOME_ZONE_CENTER' },
    }
    if (lat != null && lng != null && isFinite(lat) && isFinite(lng)) {
      try {
        const coordsStr = `${lng},${lat};${HOME_TARGET[1]},${HOME_TARGET[0]}`
        const resp = await fetch(`/osrm-route?coords=${encodeURIComponent(coordsStr)}`)
        if (resp.ok) {
          const data = await resp.json()
          if (data.routed) {
            // Detect deviation: compare straight-line vs routed distance
            const dLat = (HOME_TARGET[0] - lat) * 111000
            const dLng = (HOME_TARGET[1] - lng) * 85000
            const straightLine = Math.sqrt(dLat * dLat + dLng * dLng)
            const routed = data.distance_m || straightLine
            const desvio = routed > straightLine * 1.4 // >40% longer than straight = deviation
            routeAnalysis = {
              distancia_restante_metros: Math.round(routed),
              eta_segundos: Math.round(data.duration_s || 0),
              desvio_trayectoria: desvio,
              distancia_recta_metros: Math.round(straightLine),
              destino: { lat: HOME_TARGET[0], lng: HOME_TARGET[1], label: 'HOME_ZONE_CENTER' },
            }
          }
        }
      } catch { /* OSRM unavailable — leave nulls */ }
    }

    // GhostRail context — last 20 critical points (most recent first)
    const ghostrailContext = ghostrailPts.slice(-20).reverse().map(p => ({
      lat: p.lat, lng: p.lng, timestamp: p.t, zone: p.zone || null,
    }))

    // Loitering clusters (MAGIA2 data — valuable for OSINT analysis)
    const loiteringSummary = loiteringClusters.map(c => ({
      lat: c.lat, lng: c.lng,
      duration_min: c.duration_min,
      start_t: c.start_t, end_t: c.end_t,
      point_count: c.point_count,
    }))

    const payload = {
      metadata_analisis: {
        timestamp_extraccion: new Date().toISOString(),
        motor_origen: 'stracker_v7_engine',
        version: snapshotVersion,
        event_seq: kernelSeq,
      },
      vector_primario: {
        coordenadas: lat != null && lng != null ? [lat, lng] : null,
        velocidad_kmh: speed,
        rumbo_grados: heading,
        precision_hardware_metros: accuracy,
        nivel_bateria: battery,
        modo_movimiento: movement?.inferredMode,
        etiqueta_ubicacion: locationLabel,
        zona: pyState?.location?.zone || null,
      },
      analisis_ruta_osrm: routeAnalysis,
      spoofing_assessment: {
        nivel: spoofResult.level,
        risk_score: spoofResult.score,
        signals: spoofResult.signals,
        strong_signal_count: spoofResult.strongSignalCount,
      },
      ghostrail_contexto: ghostrailContext,
      loitering_hotspots: loiteringSummary,
      instruccion_embebida_gemini: 'Actúa como analista de OSINT. Evalúa estas coordenadas, la consistencia de la señal (jitter) y el historial de velocidad. Determina si el objetivo está en movimiento fluido, detenido en tráfico o si existe manipulación de señal (spoofing). Considera los loitering_hotspots como lugares de interés (casas, locales) visitados en las últimas 24 horas. Cross-check el rumbo_grados con la trayectoria del GhostRail para detectar inconsistencias.',
    }
    return payload
  }

  const copyForensicTelemetry = async () => {
    try {
      const payload = await buildForensicPayload()
      const jsonStr = JSON.stringify(payload, null, 2)
      // Clipboard with fallback
      try {
        await navigator.clipboard.writeText(jsonStr)
      } catch {
        // Fallback: textarea + execCommand
        const ta = document.createElement('textarea')
        ta.value = jsonStr
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
      }
      // Haptic feedback per Gemini spec
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate([20, 50, 20])
      }
      setForensicCopied(true)
      showToast('📋 Telemetría Forense copiada — pega en Gemini')
      setTimeout(() => setForensicCopied(false), 3000)
    } catch (e) {
      showToast('⚠️ Error generando telemetría')
    }
  }

  const downloadForensicTelemetry = async () => {
    try {
      const payload = await buildForensicPayload()
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `stracker-forensic-${Date.now()}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showToast('⬇ Telemetría descargada')
    } catch {
      showToast('⚠️ Error descargando')
    }
  }

  // ── MAGIA4 (Gemini directive): Drone Follow Mode ──
  // If the user hasn't interacted with the map (pan/zoom) for 5s AND
  // followMode is on AND target is moving, enter drone mode: use flyTo()
  // to project the camera ahead based on heading + speed, keeping the
  // target in the lower third of the screen.
  useEffect(() => {
    if (!mapInstanceReady) return
    const map = mapInstanceRef.current
    if (!map) return

    // Mark user interaction timestamps
    const onUserInteract = () => {
      lastMapInteractionRef.current = Date.now()
      if (droneMode) setDroneMode(false)
    }
    map.on('zoomstart', onUserInteract)
    map.on('dragstart', onUserInteract)

    // Idle checker — every 1s, see if we've been idle 5s+
    const IDLE_THRESHOLD = 5000
    const checker = setInterval(() => {
      if (!followModeRef.current) return
      const idle = Date.now() - lastMapInteractionRef.current
      if (idle >= IDLE_THRESHOLD && !droneMode) {
        // Check if target is moving (speed > 2 km/h)
        const speed = movement.speedKmh ?? 0
        if (speed > 2) {
          setDroneMode(true)
        }
      }
    }, 1000)

    return () => {
      clearInterval(checker)
      map.off('zoomstart', onUserInteract)
      map.off('dragstart', onUserInteract)
    }
  }, [mapInstanceReady, droneMode, movement.speedKmh])

  // Drone mode camera projection — flyTo with heading-based offset
  useEffect(() => {
    if (!droneMode || !snapshot?.state) return
    const map = mapInstanceRef.current
    if (!map) return

    const lat = mapData?.lat ?? mapLat
    const lng = mapData?.lng ?? mapLng
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return

    const speed = movement.speedKmh ?? 0
    const heading = pyState?.gps?.heading ?? pyState?.location?.heading ?? null

    // Project a point ahead based on heading + speed
    // (higher speed = look further ahead, capped at ~200m)
    const lookAheadM = Math.min(200, speed * 8) // 50km/h → 400m capped at 200m
    let projLat = lat
    let projLng = lng
    if (heading != null && isFinite(heading) && speed > 2) {
      const bearingRad = (heading * Math.PI) / 180
      const distDeg = lookAheadM / 111000
      projLat = lat + distDeg * Math.cos(bearingRad)
      projLng = lng + (distDeg / Math.cos(lat * Math.PI / 180)) * Math.sin(bearingRad)
    }

    // Center the camera on the PROJECTED point so the actual target sits
    // in the lower third of the screen (cinematic drone follow)
    try {
      const targetPoint = map.latLngToContainerPoint([lat, lng] as any)
      // Shift the center UP by 1/6 of viewport height → target in lower third
      const shifted = map.containerPointToLatLng([
        targetPoint.x,
        targetPoint.y + (map.getSize().y / 6),
      ] as any)
      map.flyTo([shifted.lat + (projLat - lat), shifted.lng + (projLng - lng)],
        map.getZoom(), { duration: 2.5, easeLinearity: 0.25 })
    } catch {
      // Fallback: simple panTo
      map.panTo([projLat, projLng], { animate: true, duration: 2.5 })
    }
  }, [droneMode, snapshot, mapData, mapLat, mapLng, movement.speedKmh, pyState])

  // ── MC_8_01 (stracker_v8_hyper_premium): Pseudo-3D Drive Mode ──
  // When drone follow is active AND speed > 40km/h, ramp --drive-tilt from 0
  // to 1. The CSS var tilts the .leaflet-tile-pane + .leaflet-overlay-pane via
  // perspective(1200px) rotateX(32deg), giving a Tesla/Apple Maps driving view.
  // Ramp is eased by the CSS transition (800ms cubic-bezier). Below 40km/h or
  // when drone mode exits, tilt returns to 0 (flat cenital).
  useEffect(() => {
    const speed = movement.speedKmh ?? 0
    const shouldTilt = droneMode && speed > 40
    setDriveTilt(shouldTilt ? 1 : 0)
  }, [droneMode, movement.speedKmh])

  // ── MC_8_02: Circadian clock — ticks every 60s so MapStyleInyector ──
  // re-evaluates the time-of-day phase and transitions the color wash.
  useEffect(() => {
    const id = setInterval(() => setCircadianNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])

  // ── AT_4 (stracker_v8_hyper_premium): Interface occlusion by gestures ──
  // When the user pans (touchmove) or zooms (wheel) the map, add a
  // `map-gesture-active` class to <body>. The CSS rule dims all `.gesture-dim`
  // elements (FloatingControls, DynamicIsland, drone badge, scrubber) to 0.25
  // opacity so the map gets maximum visual area. Class is removed 600ms after
  // the last gesture ends (debounced) so the UI fades back in gracefully.
  useEffect(() => {
    if (!mapInstanceReady || typeof document === 'undefined') return
    const map = mapInstanceRef.current
    const container = map?.getContainer?.() as HTMLElement | undefined
    if (!container) return

    const armOcclusion = () => {
      document.body.classList.add('map-gesture-active')
      if (gestureOccludeTimerRef.current) clearTimeout(gestureOccludeTimerRef.current)
      gestureOccludeTimerRef.current = setTimeout(() => {
        document.body.classList.remove('map-gesture-active')
      }, 600)
    }

    // Touch pan + wheel zoom both trigger occlusion. We use raw DOM input
    // events (touchmove / wheel / pointerdown / pointermove) instead of
    // Leaflet's `drag`/`zoom` events because the latter ALSO fire during
    // programmatic animations (initial flyTo, tile-load adjustments, drone
    // follow flyTo) — which would continuously re-arm the 600ms debounce and
    // leave `map-gesture-active` stuck on <body>, permanently dimming the UI.
    // Raw pointer events only fire for genuine user input.
    const onPointerDown = (e: PointerEvent) => {
      // Only arm for primary button presses (left mouse / touch / pen)
      if (e.isPrimary) armOcclusion()
    }
    const onPointerMove = (e: PointerEvent) => {
      // Re-arm while a button is held down (active drag)
      if (e.buttons > 0) armOcclusion()
    }
    container.addEventListener('touchmove', armOcclusion, { passive: true })
    container.addEventListener('wheel', armOcclusion, { passive: true })
    container.addEventListener('pointerdown', onPointerDown, { passive: true })
    container.addEventListener('pointermove', onPointerMove, { passive: true })

    return () => {
      container.removeEventListener('touchmove', armOcclusion)
      container.removeEventListener('wheel', armOcclusion)
      container.removeEventListener('pointerdown', onPointerDown)
      container.removeEventListener('pointermove', onPointerMove)
      if (gestureOccludeTimerRef.current) clearTimeout(gestureOccludeTimerRef.current)
      document.body.classList.remove('map-gesture-active')
    }
  }, [mapInstanceReady])

  return (
    <div className="w-full h-[100dvh] relative overflow-hidden" style={{ background: '#000000' }}>
      {/* ══ FULL SCREEN MAP ══ */}
      {/* HOTFIX stracker_map_data_safety: ErrorBoundary wraps the map subtree.
          If any child (LiveMarker, GhostTrail, LoiteringHeatmap, DriftDebugMarker)
          throws during render — e.g. a malformed coord slipped past the
          sanitizePointsArray guards, or leaflet internals crash — we fall
          back to <MapPlaceholder /> (friendly "Error de carga: Reintenta la
          importación" + retry button) instead of a black screen of death. */}
      <MapErrorBoundary>
        {mapReady && (
          <div
            className="absolute inset-0 z-0"
          style={{
            // T5 magic #1 (M1): map tile blur synced with sheet progress.
            // Per stracker_v7_ui_evolution: backdrop-blur(sheetProgress*6px) brightness(1-0.3).
            // CSS var applied ONLY to .leaflet-tile-pane (NOT marker pane) → pin stays crisp.
            // Desktop: sheetProgress=0 → no blur. Mobile full sheet → 6px blur + 30% darken.
            ['--map-tile-blur' as any]: `${(sheetProgress * 6).toFixed(1)}px`,
            ['--map-tile-brightness' as any]: (1 - sheetProgress * 0.3).toFixed(2),
            // MC_8_01: Pseudo-3D Drive Mode — driveTilt [0..1] tilts the tile +
            // overlay panes into a Tesla-style driving perspective (see globals.css).
            ['--drive-tilt' as any]: driveTilt.toFixed(2),
          }}
        >
          <MapContainer
            center={[centerLat, centerLng]}
            zoom={persistedZoom}
            zoomControl={false}
            attributionControl={false}
            style={{ width: '100%', height: '100%' }}
            ref={(ref: any) => { mapRef.current = ref }}
            whenReady={(mapObj: any) => {
              const map = mapObj.target || mapObj.map
              mapInstanceRef.current = map
              // Signal that the map instance is ready for event binding
              setMapInstanceReady(true)
              // Always restore persisted zoom on map init
              const targetZoom = userZoomRef.current || persistedZoom
              if (map.getZoom() !== targetZoom) {
                map.setZoom(targetZoom, { animate: false })
              }
            }}
          >
            {isSatellite ? (
              <>
                <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} />
                <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png" maxZoom={22} subdomains="abcd" />
              </>
            ) : (
              <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" maxZoom={22} subdomains="abcd" />
            )}
            {/* V6.0 stracker_fix_geospatial_drift: LiveMarker uses the
                calibrated display position (WGS84-normalized + snap-to-road
                + NAV_03 door-snap interpolation). The raw backend coord is
                rendered separately as a red crosshair for drift diagnostics. */}
            {mapData?.lat != null && mapData?.lng != null && isFinite(mapData.lat) && isFinite(mapData.lng) && !scrubbedPoint && (() => {
              // Prefer the V6.0 calibrated position; fall back to the legacy
              // getDisplayPosition(mapData) if calibration hasn't run yet.
              const displayPos = calibratedDisplayPos ?? getDisplayPosition(mapData.lat, mapData.lng, snapState)
              return (
                <>
                  <LiveMarker
                    lat={displayPos.lat}
                    lng={displayPos.lng}
                    speedLabel={mapData.show_speed ? mapData.speed_label : ''}
                    accuracy={gpsAccuracy}
                    solarDate={circadianNow}
                    heading={effectiveHeading}
                    headingLatch={effectiveHeadingLatch}
                  />
                  {/* V9 TARGETING_RETICLE: static red crosshair centered on the
                      map viewport (NOT a Leaflet marker). Rendered as a sibling
                      div so it stays fixed regardless of pan/zoom. */}
                  {/* DEBUG_OVERLAY_INJECTION: red crosshair at the RAW backend
                      coordinate. Only rendered when it differs from the
                      rendered pin by > 1m, so the map isn't cluttered when
                      drift is zero. */}
                  {normalizedPin && (
                    <DriftDebugMarker
                      key={`drift-${normalizedPin.lat.toFixed(6)}-${normalizedPin.lng.toFixed(6)}`}
                      rawLat={normalizedPin.lat}
                      rawLng={normalizedPin.lng}
                      renderedLat={displayPos.lat}
                      renderedLng={displayPos.lng}
                      driftM={driftDebugRef.current.driftM}
                      snapReason={driftDebugRef.current.snapReason}
                    />
                  )}
                </>
              )
            })()}
            {/* MAGIA1: When scrubbing, show the marker at the scrubbed point instead.
                V5.7 NAV_02: heading is computed from the historical slice. */}
            {scrubbedPoint && (
              <LiveMarker
                lat={scrubbedPoint.lat}
                lng={scrubbedPoint.lng}
                speedLabel="⏮ SCRUB"
                accuracy={gpsAccuracy}
                solarDate={circadianNow}
                heading={effectiveHeading}
                headingLatch={effectiveHeadingLatch}
              />
            )}
            {/* MAGIA2: Thermal Clusters of Detention (loitering heatmaps) */}
            {ghostVisible && loiteringClusters.map((c, i) => (
              <LoiteringHeatmap key={`loit-${i}`} lat={c.lat} lng={c.lng} radiusM={c.radius_m} durationMin={c.duration_min} />
            ))}
            {/* LAYER_01 / FIX_LAYER_03 (stracker_core_ui): GhostTrail re-render
                forzado via key. z-index: overlayPane=400 (above tilePane=200,
                below markerPane=600). Polyline pointer-events disabled in CSS so
                the overlay NEVER consumes click/touch events meant for the pin. */}
            {ghostVisible && routedTrailPts.length >= 2 && (
              <GhostTrail key={`ghost-${routedTrailPts.length}`} routedPoints={routedTrailPts} />
            )}
          </MapContainer>
          {/* V9 TARGETING_RETICLE: static red crosshair pinned to the CENTER of
              the map viewport. This is a plain div overlay (pointer-events:
              none) layered ABOVE the Leaflet panes but below the glass UI.
              It does NOT pan with the map — it stays fixed as a visual
              reference for the operator ("what the device is centered on"). */}
          <div
            className="pointer-events-none absolute z-[1500]"
            style={{
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: '52px',
              height: '52px',
            }}
            aria-hidden="true"
          >
            {/* Horizontal reticle line */}
            <div style={{ position: 'absolute', top: '50%', left: 0, width: '100%', height: '1.5px', background: '#ff3b30', transform: 'translateY(-50%)', boxShadow: '0 0 4px rgba(255,59,48,.7)' }} />
            {/* Vertical reticle line */}
            <div style={{ position: 'absolute', left: '50%', top: 0, height: '100%', width: '1.5px', background: '#ff3b30', transform: 'translateX(-50%)', boxShadow: '0 0 4px rgba(255,59,48,.7)' }} />
            {/* Center dot */}
            <div style={{ position: 'absolute', top: '50%', left: '50%', width: '5px', height: '5px', borderRadius: '50%', background: '#ff3b30', transform: 'translate(-50%, -50%)', boxShadow: '0 0 6px rgba(255,59,48,.95)' }} />
            {/* Corner brackets — NW */}
            <div style={{ position: 'absolute', top: '-3px', left: '-3px', width: '9px', height: '9px', borderTop: '1.5px solid #ff3b30', borderLeft: '1.5px solid #ff3b30' }} />
            {/* NE */}
            <div style={{ position: 'absolute', top: '-3px', right: '-3px', width: '9px', height: '9px', borderTop: '1.5px solid #ff3b30', borderRight: '1.5px solid #ff3b30' }} />
            {/* SW */}
            <div style={{ position: 'absolute', bottom: '-3px', left: '-3px', width: '9px', height: '9px', borderBottom: '1.5px solid #ff3b30', borderLeft: '1.5px solid #ff3b30' }} />
            {/* SE */}
            <div style={{ position: 'absolute', bottom: '-3px', right: '-3px', width: '9px', height: '9px', borderBottom: '1.5px solid #ff3b30', borderRight: '1.5px solid #ff3b30' }} />
          </div>
          {/* V5.5 UI_PURGE_PLACEHOLDER: 'Sin actividad reciente' text overlay
              REMOVED. When there is no trail data, the map stays clean — visual
              silence is preferable to an intrusive 'no data' label. */}
          {/* MC_8_02: Circadian Illumination Engine — time-of-day color wash
              layered above tiles (z-200) but below markers (z-9999). */}
          <MapStyleInyector now={circadianNow} />
        </div>
      )}
      </MapErrorBoundary>

      {/* ══ OVERLAYS ══ */}
      {overlays.spoof && (
        <div className="fixed inset-0 z-[5] pointer-events-none" style={{
          boxShadow: 'inset 0 0 160px 40px rgba(255,255,255,.06)',
          animation: 'spoofPulse 2s ease-in-out infinite',
        }} />
      )}
      {overlays.signal && (
        <div className="fixed inset-0 z-[5] pointer-events-none" style={{
          boxShadow: 'inset 0 0 160px 40px rgba(255,255,255,.04)',
          animation: 'signalPulse 2s ease-in-out infinite',
        }} />
      )}

      {/* ══ ZOOM CONTROLS — V5.5 Deep Black floating glass, V6.0 Apple Maps 4000 ══ */}
      <div className="fixed right-4 md:right-8 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-3 md:gap-4">
        <button
          className="flex items-center justify-center min-h-11 min-w-11 w-11 h-11 rounded-full cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
          style={{
            background: 'rgba(10,10,10,0.85)',
            backdropFilter: 'blur(30px) saturate(180%)',
            WebkitBackdropFilter: 'blur(30px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.05)',
            color: 'rgba(255,255,255,.7)',
            boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.4)',
            fontSize: 20,
            fontWeight: 300,
          }}
          onClick={() => {
            if (!mapInstanceRef.current) return
            const z = mapInstanceRef.current.getZoom() + 1
            mapInstanceRef.current.setZoom(z)
          }}
        >
          +
        </button>
        <button
          className="flex items-center justify-center min-h-11 min-w-11 w-11 h-11 rounded-full cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98]"
          style={{
            background: 'rgba(10,10,10,0.85)',
            backdropFilter: 'blur(30px) saturate(180%)',
            WebkitBackdropFilter: 'blur(30px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.05)',
            color: 'rgba(255,255,255,.7)',
            boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.4)',
            fontSize: 20,
            fontWeight: 300,
          }}
          onClick={() => {
            if (!mapInstanceRef.current) return
            const z = mapInstanceRef.current.getZoom() - 1
            mapInstanceRef.current.setZoom(z)
          }}
        >
          −
        </button>
      </div>

      {/* ══ MAGIA4: DRONE FOLLOW MODE INDICATOR ══
          AT_4: gesture-dim dims during map pan/zoom. MC_8_01: badge shows the
          Pseudo-3D Drive Mode state when speed > 40km/h (tilt engaged). */}
      {droneMode && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-20 gesture-dim flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{
            // V6.0: expansive top inset (was 48/12) — pushes drone badge below the DynamicIsland.
            top: isMobile ? 64 : 24,
            background: 'rgba(10,10,10,0.85)',
            backdropFilter: 'blur(30px) saturate(180%)',
            WebkitBackdropFilter: 'blur(30px) saturate(180%)',
            border: '1px solid rgba(255,255,255,0.05)',
            boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 24px 64px rgba(0,0,0,.45)',
            animation: 'dronePulse 2s ease-in-out infinite',
          }}
        >
          <Navigation size={11} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.85)' }} />
          <span className="font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.85)', fontSize: 'clamp(9px, 1.2vw, 10px)' }}>
            {driveTilt > 0.5 ? 'DRIVE MODE 3D' : 'DRONE FOLLOW'}
          </span>
        </div>
      )}

      {/* ══ V5.7 NAV_01: TIMELINE BAR — integrated beneath the map ══
          Replaces the old floating glass-pill time scrubber. Deep Black
          glassmorphism consistent with the rest of the dashboard. Shows
          "Tiempo Real" (live, Apple blue) vs "Histórico" (scrubbing, white)
          mode indicator + 24h track with T-24h → T-0 endpoints.
          AT_4: gesture-dim dims during map pan/zoom. */}
      {ghostVisible && ghostrailPts.length >= 2 && (
        <div
          className="timeline-bar fixed left-1/2 -translate-x-1/2 z-20 gesture-dim"
          style={{
            // V6.0 Apple Maps 4000 — expansive bottom insets: 16px mobile, 32px desktop.
            bottom: isMobile ? 16 : 32,
            width: 'min(92vw, 600px)',
          }}
        >
          <TimelineBar
            points={ghostrailPts}
            scrubIndex={timeScrubIndex}
            scrubbing={scrubbing}
            onScrub={(idx) => {
              setTimeScrubIndex(idx)
              setScrubbing(true)
              // Invalidate map size after scrub change
              if (mapInstanceRef.current) {
                try { mapInstanceRef.current.invalidateSize() } catch {}
              }
            }}
            onLive={() => { setScrubbing(false); setTimeScrubIndex(null) }}
          />
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          V8 LEGACY_CODE_ERADICATION: cookie UI removed.
          The floating key button + CookieDrawer + CookiesBlock all relied
          on /api/cookies* endpoints that do not exist in the Python backend.
          They are gone from the render tree to stop the 404 spam.
      ══════════════════════════════════════════════════════════════════ */}

      {/* ══════════════════════════════════════════════════════════════════
          FLOATING GLASS MINIBLOCK — bottom-fixed, rounded-2xl
          F1: +60px bottom offset to keep drawer away from pin area
          P6: Everything centered in viewport (margin: 0 auto)
          B1: Fluid max-width with responsive clamp
          Layout:
            ROW 0: SPOOF BADGE + CONNECTION
            ROW 1: LOCATION label (ONCE ONLY, dedupe)
            ROW 2: F2 COMPACT SINGLE LINE: 🚗20km | 🔋20% | 📶WIFI | 📱ON·3m | 📡👍
            ROW 3: BUTTON BAR (flex-wrap for small screens)
            ROW 4: VER MÁS CTA toggle + accordion (F1: reduced max-height)
          ══════════════════════════════════════════════════════════════════ */}
      {/* ══════════════════════════════════════════════════════════════════
          V9 COMPACT HEIGHT-AWARE REDESIGN — layout_priority:
            1. Estado (single compact metrics line)
            2. Botonera (icon-only: 🛰️ 📍 👻 📋) — INSIDE panel
            3. Cookies (collapsed 34px, force-collapse on tiny)
            4. VER MÁS (only expandable block, hidden on tiny)
          Height budget: desktop 180px / mobile 170px / tiny 140px.
          Pin safety: panel never covers viewport center (pin at vh/2).
      ══════════════════════════════════════════════════════════════════ */}
      {/* ══ T3: FLOATING MAP CONTROLS — top-right circular glass (isolated from panel) ══
          AT_4: gesture-dim wrapper dims controls to 0.25 opacity while the user
          pans/zooms the map (body.map-gesture-active toggled by TrackerView). */}
      <div className="gesture-dim">
        <FloatingControls
          isSatellite={isSatellite}
          onToggleSatellite={() => setIsSatellite(!isSatellite)}
          onCenter={centerCamera}
          ghostVisible={ghostVisible}
          onToggleGhost={() => setGhostVisible(!ghostVisible)}
        />
      </div>

      {/* ══ MC_8_03 (stracker_v8_hyper_premium): DYNAMIC ISLAND HUD ══
          Replaces StateChip + standalone Toast. Compact pill shows live
          telemetry (movement • place • zone) with a heartbeat-pulsing LED.
          Expands elastically to surface alerts (spoof, zone change, arrival).
          AT_4: gesture-dim dims the island while the user manipulates the map. */}
      <div className="gesture-dim">
        <DynamicIsland
          movementIcon={movement.compactIcon}
          movementLabel={movement.inferredMode === 'SLEEP' ? 'Dormida' : movement.displayMode}
          placeLabel={locationLabel}
          zoneLabel={pyState?.location?.zone === 'HOME' ? 'Casa' : pyState?.location?.zone === 'WORK' ? 'Trabajo' : pyState?.location?.zone === 'TRANSIT' ? 'En ruta' : undefined}
          zoneColor="rgba(255,255,255,.55)"
          spoofColor={spoofResult.color}
          spoofLevel={spoofResult.level}
          isMobile={isMobile}
          alert={islandAlert}
          heartbeatTs={heartbeatTs}
          onAlertDismiss={() => setIslandAlert(null)}
        />
      </div>

      {/* ════════════════════════════════════════════════════════════════════
          V11 BOTTOM SHEET — Apple Maps style, inline (replaces TrackerSheet).
          Collapsed: ~22vh (≤25-30% per spec → V9 crosshair + pin never covered)
          Expanded: ~55vh (telemetry + forensic + ver más accordion)
          Strict Dark Mode: bg-black/70, backdrop-blur-lg, border-gray-800.
          Drag Handle: bg-zinc-600 bar, 44px tap target, tap to toggle.
          All buttons ≥44×44px (min-h-11 / w-11 h-11 / p-3).
          V9 targeting crosshair (z-[1500]) is rendered separately above this
          sheet and is NEVER covered (collapsed = 22vh).
          ════════════════════════════════════════════════════════════════════ */}
      <div
        className="fixed left-0 right-0 bottom-0 z-20 flex flex-col pointer-events-auto"
        style={{
          height: sheetExpanded ? '55vh' : '22vh',
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(16px)',
          WebkitBackdropFilter: 'blur(16px)',
          borderTop: '1px solid #1f2937',
          borderRadius: '20px 20px 0 0',
          boxShadow: '0 -8px 32px rgba(0,0,0,.5)',
          transition: 'height 350ms cubic-bezier(0.2,0.8,0.2,1)',
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        }}
      >
        {/* DRAG HANDLE — bg-zinc-600 bar, 44px tap target, tap to toggle */}
        <button
          aria-label={sheetExpanded ? 'Colapsar panel' : 'Expandir panel'}
          className="flex justify-center items-center w-full pt-3 pb-2 cursor-pointer flex-shrink-0 transition-all active:scale-95"
          style={{ minHeight: 44, touchAction: 'none' }}
          onClick={() => setSheetExpanded(!sheetExpanded)}
        >
          <div style={{ width: 40, height: 5, borderRadius: 3, background: '#52525b' }} />
        </button>

        {/* SCROLLABLE CONTENT */}
        <div className="flex-1 overflow-y-auto px-4 pb-4" style={{ scrollbarWidth: 'none' }}>

          {/* ── ROW 1: LIVE TOGGLE (V11 isLiveMode) + SPEED + HEADING ── */}
          <div className="flex items-center gap-3 mb-3">
            {/* V11 Live/Pause toggle — 44px touch target, #ff3b30 when live */}
            <button
              aria-label={isLiveMode ? 'Pausar modo live' : 'Activar modo live'}
              className="flex items-center justify-center w-11 h-11 rounded-full cursor-pointer flex-shrink-0 transition-all active:scale-95"
              style={{
                background: isLiveMode ? 'rgba(255,59,48,0.18)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${isLiveMode ? 'rgba(255,59,48,0.5)' : '#1f2937'}`,
                color: isLiveMode ? '#ff3b30' : 'rgba(255,255,255,0.5)',
              }}
              onClick={() => setIsLiveMode(!isLiveMode)}
            >
              <Radio size={16} strokeWidth={2} />
            </button>

            {/* Speed — primary readout */}
            <div className="flex flex-col flex-1 min-w-0">
              <span className="font-light uppercase tracking-wider text-gray-500" style={{ fontSize: 9, letterSpacing: '0.08em' }}>Velocidad</span>
              <span className="font-semibold tabular-nums text-white" style={{ fontSize: 20, letterSpacing: '-0.02em' }}>
                {movement.speedKmh == null ? '--' : movement.speedKmh.toFixed(1)}
                <span className="text-gray-500 font-light ml-1" style={{ fontSize: 11 }}>km/h</span>
              </span>
            </div>

            {/* Heading — V9 effectiveHeading (payload-injected) */}
            <div className="flex flex-col items-end">
              <span className="font-light uppercase tracking-wider text-gray-500" style={{ fontSize: 9, letterSpacing: '0.08em' }}>Rumbo</span>
              <span className="font-semibold tabular-nums text-white" style={{ fontSize: 15 }}>
                {effectiveHeading != null ? `${Math.round(effectiveHeading)}°` : '--'}
              </span>
            </div>
          </div>

          {/* ── ROW 2: COMPACT METRIC PILLS — spoof, battery, network, gps, screen ── */}
          {snapshot ? (
            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mb-3" style={{ scrollbarWidth: 'none' }}>
              <SpoofBadgeV2 result={spoofResult} />
              {batteryLabel && (
                <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid #1f2937' }}>
                  <Battery size={12} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,0.7)' }} />
                  <span className="font-semibold tabular-nums text-gray-200" style={{ fontSize: 10 }}>{batteryLabel}%</span>
                </div>
              )}
              <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid #1f2937' }}>
                {(() => { const NIcon = resolveNetworkIcon(networkTypeToToken(network.type)); return <NIcon size={12} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,0.7)' }} /> })()}
                <span className="font-semibold uppercase text-gray-200" style={{ fontSize: 10 }}>{network.type}</span>
              </div>
              <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid #1f2937' }}>
                <Signal size={12} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,0.7)' }} />
                <span className="font-semibold uppercase text-gray-200" style={{ fontSize: 10 }}>{gpsQuality}</span>
              </div>
              <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid #1f2937' }}>
                <Smartphone size={12} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,0.7)' }} />
                <span className="font-semibold uppercase text-gray-200" style={{ fontSize: 10 }}>{screen.shortLabel}</span>
              </div>
              <span className="font-mono text-gray-600 ml-auto flex-shrink-0" style={{ fontSize: 9 }}>v{snapshotVersion}</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 mb-3">
              <div className="skeleton-shimmer h-5 w-16 rounded-full" />
              <div className="skeleton-shimmer h-5 w-12 rounded-full" />
              <div className="skeleton-shimmer h-5 w-14 rounded-full" />
            </div>
          )}

          {/* ── ROW 3: PLACE + COORDS + LIVE INDICATOR (always visible) ── */}
          <div className="flex items-center justify-between gap-2 pb-2 mb-2 border-b border-gray-800">
            <div className="flex items-center gap-2 min-w-0">
              {(() => { const MIcon = resolveMovementIcon(movement.compactIcon); return <MIcon size={14} strokeWidth={1.5} style={{ color: movement.isActive ? '#ff3b30' : 'rgba(255,255,255,0.5)' }} /> })()}
              <div className="min-w-0">
                <div className="font-semibold text-white truncate" style={{ fontSize: 12 }}>{locationLabel || 'Sin ubicación'}</div>
                <div className="font-mono text-gray-500 tabular-nums" style={{ fontSize: 10 }}>
                  {verMasGps?.lat_str || '--'} · {verMasGps?.lng_str || '--'}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: wsConnected ? '#ff3b30' : 'rgba(255,255,255,0.25)', boxShadow: wsConnected ? '0 0 6px #ff3b30' : 'none' }} />
              <span className="font-semibold uppercase text-gray-400" style={{ fontSize: 9 }}>{wsConnected ? 'LIVE' : 'OFFLINE'}</span>
            </div>
          </div>

          {/* ════════════════════════════════════════════════════════════════
              EXPANDED CONTENT — only when sheetExpanded === true.
              Forensic export, cookies, ver más accordion.
              ════════════════════════════════════════════════════════════════ */}
          {sheetExpanded && (
            <div style={{ animation: 'cookiesExpand 250ms ease-out' }}>

              {/* FORENSIC EXPORT */}
              <div className="mb-3 pb-3 border-b border-gray-800">
                <div className="flex items-center gap-2 mb-2">
                  <Microscope size={12} className="text-gray-400" />
                  <span className="font-bold uppercase tracking-wider text-gray-400" style={{ fontSize: 9 }}>Forensic Export</span>
                </div>
                <div className="flex gap-2">
                  <button
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-3 rounded-xl cursor-pointer transition-all active:scale-95 min-h-11"
                    style={{
                      background: forensicCopied ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)',
                      border: `1px solid ${forensicCopied ? 'rgba(255,255,255,0.2)' : '#1f2937'}`,
                      color: 'rgba(255,255,255,0.85)',
                      fontSize: 11,
                      fontWeight: 600,
                    }}
                    onClick={copyForensicTelemetry}
                  >
                    {forensicCopied ? <Check size={13} /> : <Clipboard size={13} />}
                    <span className="uppercase">{forensicCopied ? 'Copiado' : 'Copiar Telemetría'}</span>
                  </button>
                  <button
                    aria-label="Descargar JSON"
                    className="flex items-center justify-center w-11 h-11 rounded-xl cursor-pointer transition-all active:scale-95"
                    style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid #1f2937', color: 'rgba(255,255,255,0.6)' }}
                    onClick={downloadForensicTelemetry}
                  >
                    <Download size={14} />
                  </button>
                </div>
                <div className="mt-1.5 text-gray-600" style={{ fontSize: 9 }}>
                  {ghostrailPts.length} pts · {loiteringClusters.length} hotspots · spoof {spoofResult.score}%
                </div>
              </div>

              {/* V11: CookiesBlock removed — V8 LEGACY_CODE_ERADICATION.
                  Backend uses Google Account cookies stored in gist, not
                  browser-supplied cookies. No cookie UI needed. */}

              {/* VER MÁS TOGGLE — 44px touch target */}
              {!isShortViewport && (
                <button
                  className="w-full flex items-center justify-center gap-2 my-3 py-3 cursor-pointer transition-all active:scale-95 min-h-11"
                  style={{
                    background: showVerMas ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)',
                    border: '1px solid #1f2937',
                    borderRadius: 12,
                    color: showVerMas ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)',
                    fontSize: 11,
                    fontWeight: 600,
                    letterSpacing: '0.15em',
                    textTransform: 'uppercase' as const,
                  }}
                  onClick={() => setShowVerMas(!showVerMas)}
                >
                  <span className="transition-transform inline-block" style={{ fontSize: 12, transform: showVerMas ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}>▸</span>
                  {showVerMas ? 'Ver Menos' : 'Ver Más'}
                </button>
              )}

              {/* VER MÁS ACCORDION DRAWER */}
              {showVerMas && (
                <div className="overflow-y-auto" style={{ maxHeight: '32vh', scrollbarWidth: 'none', animation: 'cookiesExpand 150ms ease-out' }}>

                  {/* GPS */}
                  <AccordionSection title="GPS" isOpen={openSections.gps} onToggle={() => toggleSection('gps')}>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Lugar</span><span className="text-gray-200 font-medium text-right truncate ml-1">{verMasGps?.place || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Señal</span><span className="text-gray-200 font-medium">{verMasGps?.signal || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Lat</span><span className="text-gray-300 font-mono" style={{ fontSize: 9 }}>{verMasGps?.lat_str || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Prec.</span><span className="text-gray-200 font-medium">{verMasGps?.accuracy || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Lng</span><span className="text-gray-300 font-mono" style={{ fontSize: 9 }}>{verMasGps?.lng_str || '---'}</span></div>
                    </div>
                  </AccordionSection>

                  {/* Sistema */}
                  <AccordionSection title="Sistema" isOpen={openSections.sistema} onToggle={() => toggleSection('sistema')}>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-center"><div className="text-gray-600 uppercase" style={{ fontSize: 8 }}>Red</div><div className="text-gray-200 font-medium" style={{ fontSize: 11 }}>{verMasSystem?.network || 'OFFLINE'}</div></div>
                      <div className="text-center"><div className="text-gray-600 uppercase" style={{ fontSize: 8 }}>Batería</div><div className="text-gray-200 font-medium" style={{ fontSize: 11 }}>{verMasSystem?.battery_raw || '---'}</div></div>
                      <div className="text-center"><div className="text-gray-600 uppercase" style={{ fontSize: 8 }}>Movim.</div><div className="text-gray-200 font-medium" style={{ fontSize: 11 }}>{verMasSystem?.motion_raw || '---'}</div></div>
                    </div>
                  </AccordionSection>

                  {/* Eventos */}
                  <AccordionSection title="Eventos" isOpen={openSections.eventos} onToggle={() => toggleSection('eventos')}>
                    {events.length > 0 ? (
                      <div className="space-y-0.5 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
                        {events.slice(-10).reverse().map((ev) => {
                          const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}) : ''
                          return (
                            <div key={ev.seq} className="flex items-center gap-1.5 py-0.5">
                              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-gray-400" />
                              <span className="font-bold uppercase text-gray-300" style={{ fontSize: 8 }}>{ev.type.slice(0,10)}</span>
                              <span className="text-gray-500 truncate" style={{ fontSize: 9 }}>{ts}</span>
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="text-gray-600 py-1 text-center" style={{ fontSize: 9 }}>Sin eventos</div>
                    )}
                  </AccordionSection>

                  {/* GhostRail 24h */}
                  <AccordionSection title="GhostRail 24h" isOpen={openSections.ghostrail} onToggle={() => toggleSection('ghostrail')}>
                    <div className="flex items-center gap-3 mb-1.5 flex-wrap">
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500 uppercase" style={{ fontSize: 9 }}>Pts</span>
                        <span className="text-gray-200 font-medium" style={{ fontSize: 11 }}>{ghostrailPts.length}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500 uppercase" style={{ fontSize: 9 }}>Routed</span>
                        <span className="text-gray-200 font-medium" style={{ fontSize: 11 }}>{routedTrailPts.length}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500 uppercase" style={{ fontSize: 9 }}>Src</span>
                        <span className="text-gray-200 font-medium" style={{ fontSize: 11 }}>{ghostrailDiagnostics.current.source}</span>
                      </div>
                    </div>
                  </AccordionSection>

                  {/* Diagnóstico */}
                  <AccordionSection title="Diagnóstico" isOpen={openSections.diagnostico} onToggle={() => toggleSection('diagnostico')}>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Kernel</span><span className="text-gray-200 font-medium">{snapshot ? 'Activo' : 'Sin señal'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Seq</span><span className="text-gray-300 font-mono" style={{ fontSize: 9 }}>{kernelSeq}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Socket</span><span className="text-gray-200 font-medium">{socketConnected ? 'WS Live' : 'HTTP poll'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Poll</span><span className="font-medium" style={{ color: isLiveMode ? (wsConnected ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.4)') : '#ff3b30' }}>{isLiveMode ? (wsConnected ? 'KILLED' : '3s') : 'PAUSED'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Zoom</span><span className="text-gray-300 font-mono" style={{ fontSize: 9 }}>{userZoom}x</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Heading</span><span className="text-gray-300 font-mono" style={{ fontSize: 9 }}>{effectiveHeading != null ? `${Math.round(effectiveHeading)}°${effectiveHeadingLatch ? ' L' : ''}` : '—'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Live</span><span className="font-medium" style={{ color: isLiveMode ? '#ff3b30' : 'rgba(255,255,255,0.4)' }}>{isLiveMode ? 'ON' : 'PAUSED'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 10 }}><span className="text-gray-500 uppercase">Spoof</span><span className="font-medium" style={{ color: spoofResult.color }}>{spoofResult.icon} {spoofResult.score}%</span></div>
                    </div>
                  </AccordionSection>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ══ V8: TOAST removed — DynamicIsland (MC_8_03) now surfaces all alerts.
          The legacy `toast` state is mirrored into islandAlert by the useEffect
          above, so existing showToast() call sites continue to work. */}

      {/* ══ M8: LOADING — V5.5 Deep Black non-invasive skeleton, V6.0 Apple Maps 4000 ══ */}
      {!snapshot && (
        <div
          className="fixed top-4 md:top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
          style={{
            background: 'rgba(10,10,10,.85)',
            backdropFilter: 'blur(30px) saturate(180%)',
            WebkitBackdropFilter: 'blur(30px) saturate(180%)',
            border: '1px solid rgba(255,255,255,.05)',
            boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 24px 64px rgba(0,0,0,.45)',
          }}
        >
          <span
            className="w-2 h-2 rounded-full"
            style={{ background: 'rgba(255,255,255,.85)', animation: 'led-pulse-calm 1.4s ease-in-out infinite' }}
          />
          <span className="micro-telemetry">Conectando al kernel…</span>
        </div>
      )}
    </div>
  )
}
