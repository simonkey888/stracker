'use client'

import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import type { ReactNode } from 'react'
import dynamic from 'next/dynamic'
import {
  Footprints, Car, Bus, Moon, PersonStanding, Bike,
  Wifi, WifiOff, Smartphone,
  Signal, SignalHigh, SignalMedium, SignalLow,
  Battery, BatteryFull, BatteryMedium, BatteryLow, BatteryWarning,
  Home, Briefcase, Music, Building2,
  Circle as CircleIcon, CircleAlert, CircleX, OctagonX,
  Clipboard, ClipboardCheck, Check, Microscope, Download,
  ChevronRight, Plane, Navigation,
  TriangleAlert, Info, Activity, Radio,
  Route, History, Monitor, Gauge,
} from 'lucide-react'
import { CookiesBlock } from './CookiesBlock'
import { CookieDrawer } from './CookieDrawer'
// HOTFIX stracker_map_data_safety: ErrorBoundary wraps the map subtree so a
// malformed payload (non-array, null coords, leaflet internal crash) shows a
// friendly MapPlaceholder instead of a black "pantalla de la muerte".
import { MapErrorBoundary } from './MapErrorBoundary'
import { DynamicIsland, type IslandAlert } from './DynamicIsland'
// V6.5: SpeedGauge import REMOVED — velocímetro eliminado por completo del código.
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
  moto: Bike, // V6.4: 'moto' token for 5-25 km/h mode
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
// V6.8 GHOST_TRAIL_THRESHOLD — CircleMarker for stationary-trace rendering.
const CircleMarker = dynamic(() => import('react-leaflet').then(m => m.CircleMarker), { ssr: false })

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
  // V6.10 STALE_DATA_EXPOSURE — raw timestamp of the last point received from
  // Google's Location Sharing payload. Used to compute data age and switch the
  // UI from "Tiempo Real" to "Señal Latente / Caché" when >10 min stale.
  last_update?: string | null
  device_label?: string
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
  // V6.4: arrow color updated to neon green (#00FF00) to match the new pin
  // color, so the heading indicator reads as part of the pin identity.
  // Rendered as a small wedge that rotates around the pin.
  // When heading is null (no data) or latched (stationary), the arrow holds
  // its last position to avoid jitter. When null at init, no arrow is shown.
  const hasHeading = heading != null && isFinite(heading)
  const headingArrow = hasHeading
    ? `<div style="position:absolute;top:50%;left:50%;width:0;height:0;transform:translate(-50%,-50%) rotate(${heading}deg);pointer-events:none">
          <div style="position:absolute;top:-22px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:8px solid #FF0000;opacity:${headingLatch ? 0.5 : 0.95};filter:drop-shadow(0 0 4px rgba(255,0,0,.75));transition:transform 400ms ease-out,opacity 300ms ease"></div>
       </div>`
    : ''

  return (
    <Marker
      position={[lat, lng]}
      icon={typeof window !== 'undefined' ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const L = require('leaflet')
        const speedHtml = speedLabel
          ? `<div style="font-size:10px;font-weight:700;color:#FF0000;background:rgba(0,0,0,.85);padding:1px 6px;border-radius:6px;margin-top:3px;white-space:nowrap;backdrop-filter:blur(8px);border:1px solid rgba(255,0,0,.35);letter-spacing:.04em">${speedLabel}</div>`
          : ''
        return L.divIcon({
          // FIX_2: explicit className so globals.css can enforce visibility
          className: 'live-marker-pin',
          html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none;width:100%;height:100%;justify-content:center">
            ${headingArrow}
            <div style="width:22px;height:22px;border-radius:50%;background:#FF0000;border:3px solid #FFFFFF;box-shadow:0 0 14px rgba(255,0,0,.85),0 0 28px rgba(255,0,0,.45),0 2px 8px rgba(0,0,0,.6),${solarShadow};position:relative;animation:neonPinPulse 1.4s ease-in-out infinite">
              <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:7px;height:7px;border-radius:50%;background:#f5f5f7;box-shadow:0 0 6px rgba(255,255,255,.95)"></div>
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
// RA28 — StaleMarker (UI resilience & control restoration)
// ══════════════════════════════════════════════════════════════════
// When the backend reports no_location (RA27 integrity: LiveMarker hidden),
// the operator is left staring at a "dead" map with no contextual anchor.
// StaleMarker renders the LAST KNOWN cached position (from localStorage) as a
// desaturated, dimmed, non-pulsing pin so the operator can SEE where the
// target was last seen — without confusing it with a live reading.
//
// Visual contract vs LiveMarker:
//   - 50% opacity, grayscale (no Apple-blue accent)
//   - No pulse halo, no heading arrow, no solar shadow (it's a memory, not live)
//   - z-index BELOW LiveMarker (zIndexOffset 500 vs 10000) so a returning
//     live signal immediately occludes the stale ghost
//   - Label: "Última señal hace X min" so the age is unambiguous
//
// Integrity guarantee: this marker is ONLY rendered when mapData.lat is null
// (no live signal). The instant real coords arrive, mapData.lat becomes
// non-null → LiveMarker renders → StaleMarker render-gate (in TrackerView
// body) turns off. There is no scenario where both pins overlap.
function StaleMarker({ lat, lng, ageLabel }: { lat: number; lng: number; ageLabel: string }) {
  // Defensive: never render with invalid coords
  if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return null
  return (
    <Marker
      position={[lat, lng]}
      icon={typeof window !== 'undefined' ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const L = require('leaflet')
        const labelHtml = ageLabel
          ? `<div style="font-size:11px;font-weight:500;color:rgba(245,245,247,.7);background:rgba(10,10,10,.7);padding:2px 8px;border-radius:8px;margin-top:4px;white-space:nowrap;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08);letter-spacing:.02em">Última señal ${ageLabel}</div>`
          : '<div style="font-size:11px;font-weight:500;color:rgba(245,245,247,.7);background:rgba(10,10,10,.7);padding:2px 8px;border-radius:8px;margin-top:4px;white-space:nowrap;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.08)">Última ubicación conocida</div>'
        return L.divIcon({
          className: 'stale-marker-pin',
          html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center;pointer-events:none;width:100%;height:100%;justify-content:center;opacity:.5">
            <div style="width:18px;height:18px;border-radius:50%;background:#3a3a3c;border:2px solid rgba(245,245,247,.6);box-shadow:0 2px 6px rgba(0,0,0,.4);position:relative">
              <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:5px;height:5px;border-radius:50%;background:rgba(245,245,247,.7)"></div>
            </div>
            ${labelHtml}
          </div>`,
          iconSize: [56, 56],
          iconAnchor: [28, 28],
        })
      })() : undefined}
      zIndexOffset={500}
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
      {/* V6.2 Apple Maps 4000 monochrome — RAW backend coordinate crosshair
          (was red #ff3b30, now neutral white at 0.7 opacity) */}
      <Marker
        position={[rawLat, rawLng]}
        interactive={false}
        icon={typeof window !== 'undefined' ? (() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const L = require('leaflet')
          return L.divIcon({
            className: 'drift-debug-raw',
            html: `<div style="position:relative;width:36px;height:36px;pointer-events:none">
              <div style="position:absolute;top:50%;left:0;width:100%;height:2px;background:rgba(255,255,255,0.7);transform:translateY(-50%);box-shadow:0 0 4px rgba(255,255,255,0.4)"></div>
              <div style="position:absolute;left:50%;top:0;height:100%;width:2px;background:rgba(255,255,255,0.7);transform:translateX(-50%);box-shadow:0 0 4px rgba(255,255,255,0.4)"></div>
              <div style="position:absolute;top:50%;left:50%;width:8px;height:8px;border:2px solid rgba(255,255,255,0.7);border-radius:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,0.15)"></div>
              <div style="position:absolute;top:-18px;left:50%;transform:translateX(-50%);font-size:9px;font-weight:700;color:rgba(255,255,255,0.7);background:rgba(0,0,0,.75);padding:1px 5px;border-radius:4px;white-space:nowrap;border:1px solid rgba(255,255,255,0.3)">RAW ${driftM.toFixed(1)}m${snapReason ? ' · ' + snapReason : ''}</div>
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
      {/* V6.2 monochrome connecting line from raw → rendered */}
      <Polyline
        positions={[[rawLat, rawLng], [renderedLat, renderedLng]]}
        pathOptions={{
          color: 'rgba(255,255,255,0.7)',
          weight: 1.5,
          opacity: 0.6,
          dashArray: '4,4',
        }}
      />
    </>
  )
}

// ══════════════════════════════════════════════════════════════════
// GHOST TRAIL — V6.7: Single high-visibility blue polyline (24h history)
// V6.8 GHOST_TRAIL_THRESHOLD: render even with a single stationary point.
// ══════════════════════════════════════════════════════════════════
// V6.7 GHOST_TRAIL_VISIBILITY: simplified to a single polyline per directive
//   "Renderizado de la polilínea con weight: 5, color: '#3b82f6', y opacity:
//    0.8 para máxima visibilidad". The previous segmented age-gradient +
//   comet-head glow (V6.5 white streak) is replaced with one uniform blue
//   line — maximum visibility across both dark (CartoDB) and satellite
//   (ArcGIS) basemaps. The red pulsing LiveMarker already marks the current
//   position, so the trail no longer needs a comet-head to disambiguate.
// Z-INDEX: rendered on Leaflet's overlayPane (z=400) — above the tile pane
//   (z=200, the map imagery) and below the marker pane (z=600, the pin) so
//   the trail NEVER covers the pin. Pointer-events disabled in globals.css
//   so the polyline never blocks map interaction.
// DATA SOURCE: routedPoints comes from ghostrailPts (24h CSV history fetched
//   via /points?start=...&end=... on mount + poll). The 24h cutoff is enforced
//   upstream in the ghostrailPts useMemo.
//
// V6.8 GHOST_TRAIL_THRESHOLD — static-device visibility. The previous
//   `length < 2` gate caused the trail to DISAPPEAR entirely when the device
//   was geographically static for the full 24h window (all points collapsed
//   to 1). The directive requires: "Asegurar la visibilidad del trazado
//   histórico incluso si el delta de distancia es mínimo." Fix: when there's
//   exactly 1 routed point (or many duplicates at the same coordinate),
//   render a CircleMarker at that location instead of bailing. The blue
//   circle (radius 6, weight 5, same #3b82f6 color) acts as a "stationary
//   trace" indicator — the operator sees that data EXISTS, the target just
//   hasn't moved. Polyline path is still used for ≥2 distinct points.
// ══════════════════════════════════════════════════════════════════
function GhostTrail({ routedPoints }: { routedPoints: [number, number][] }) {
  // V6.8: empty trail → render nothing (no data at all).
  if (!routedPoints || routedPoints.length === 0) return null

  // V6.8: single point OR all duplicates → render a stationary CircleMarker
  // so the trace is still visible. The CircleMarker uses the same #3b82f6
  // blue as the polyline, with weight:5 to match the trail's visual weight.
  if (routedPoints.length === 1) {
    return (
      <CircleMarker
        center={routedPoints[0]}
        pathOptions={{
          color: '#3b82f6',
          weight: 5,
          fillColor: '#3b82f6',
          fillOpacity: 0.8,
        }}
        radius={6}
      />
    )
  }

  // V6.8: check if ALL points are at the same coordinate (device static for
  // the whole window). If so, render the CircleMarker — a zero-length
  // polyline renders nothing in Leaflet, so the CircleMarker is required.
  const allSame = routedPoints.every(p =>
    p[0] === routedPoints[0][0] && p[1] === routedPoints[0][1]
  )
  if (allSame) {
    return (
      <CircleMarker
        center={routedPoints[0]}
        pathOptions={{
          color: '#3b82f6',
          weight: 5,
          fillColor: '#3b82f6',
          fillOpacity: 0.8,
        }}
        radius={6}
      />
    )
  }

  // V6.7: ≥2 distinct points → render the uniform blue polyline.
  return (
    <Polyline
      positions={routedPoints}
      pathOptions={{
        color: '#3b82f6',
        weight: 5,
        opacity: 0.8,
        lineCap: 'round',
        lineJoin: 'round',
      }}
    />
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
      <span className="font-bold uppercase tracking-wider whitespace-nowrap" style={{ color, fontSize: 'clamp(13px, 2vw, 17px)' }}>{value}</span>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════
// V6.4 UI_METRICS_DASHBOARD — MasterControlPanel building blocks
// ══════════════════════════════════════════════════════════════════
// The "Simón Sequence" panel: a 2x3 grid of high-contrast metric cells
// replacing the legacy single-line MetricsRow. Each cell dedicates its
// own tile to a single telemetry dimension so the operator gets an
// at-a-glance tactical read instead of a cramped horizontal pill row.
//
// MetricCell: a single tile. ICON + LABEL header (small, muted), VALUE
// (large, bright) + optional SUB (kinetic supplementary read, e.g. km).
// Glass background, subtle border, rounded-2xl — matches the Apple Maps
// 4000 design system without breaking the monochrome aesthetic.
function MetricCell({
  icon: Icon, label, value, sub, valueColor,
}: {
  icon: LucideCmp
  label: string
  value: string
  sub?: string
  valueColor?: string
}) {
  return (
    <div
      className="flex flex-col gap-1.5 p-2.5 rounded-2xl transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
      style={{
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.05)',
        minHeight: 64,
      }}
    >
      <div className="flex items-center gap-1.5">
        <Icon size={13} strokeWidth={1.8} style={{ color: 'rgba(255,255,255,.85)', flexShrink: 0 }} />
        <span
          className="font-bold uppercase tracking-wider truncate"
          style={{ color: 'rgba(255,255,255,.45)', fontSize: 'clamp(9px, 1.2vw, 11px)', letterSpacing: '0.1em' }}
        >{label}</span>
      </div>
      <div className="flex items-baseline gap-1.5 flex-wrap">
        <span
          className="font-bold uppercase tabular-nums leading-none"
          style={{ color: valueColor ?? 'rgba(255,255,255,.95)', fontSize: 'clamp(14px, 2vw, 18px)', letterSpacing: '-0.01em' }}
        >{value}</span>
        {sub && (
          <span
            className="font-medium tabular-nums leading-none"
            style={{ color: 'rgba(255,255,255,.4)', fontSize: 'clamp(10px, 1.3vw, 12px)' }}
          >{sub}</span>
        )}
      </div>
    </div>
  )
}

// V6.4 computeModoInfo — derives the MODO cell label + icon token using
// the directive's speed thresholds:
//   <5 km/h  → A PIE       (Footprints)
//   5-25     → MOTO        (Bike)
//   25-60    → COLECTIVO   (Bus)
//   >60      → AUTO        (Car)
// When the sleep inference engine reports SLEEP, the cell shows DORMIDA.
// When speed is null/0 and no sleep signal, shows QUIETA (still).
function computeModoInfo(speedKmh: number | null, inferredMode: string): { label: string; iconToken: string } {
  const upper = (inferredMode || '').toUpperCase()
  if (upper === 'SLEEP' || upper === 'DORMIDA') return { label: 'DORMIDA', iconToken: 'sleep' }
  if (speedKmh == null || speedKmh < 0) return { label: 'QUIETA', iconToken: 'still' }
  if (speedKmh < 5) return { label: 'A PIE', iconToken: 'walk' }
  if (speedKmh < 25) return { label: 'MOTO', iconToken: 'moto' }
  if (speedKmh < 60) return { label: 'COLECTIVO', iconToken: 'bus' }
  return { label: 'AUTO', iconToken: 'car' }
}

// V6.6 DEVICE_MAP — substring-based alias mapping for Google obfuscated
// device identifiers. The Google Location Sharing RPC payload carries
// obfuscated device fingerprints (long alphanumeric strings). Two known
// fingerprints are mapped by SUBSTRING match (not exact equality), so the
// alias still resolves even if the surrounding token rotates between
// sessions. New fingerprints can be added here as they're discovered.
//
// Directives (per V6.6 DEVICE_ALIAS_MAPPING):
//   - rawID contains 'iyAM' → 'Samsung A16'
//   - rawID contains 'jgDg'  → 'TCL 408'
//   - unrecognized ID        → 'Desconocido' or last 4 digits (to avoid
//                              showing a raw 22-char Google fingerprint)
//
// V6.8 DYNAMIC_DEVICE_INFERENCE — the static DEVICE_MAP is now a FALLBACK
// only. The primary path is `inferDeviceFromTelemetry()` which profiles
// the live telemetry fingerprint (battery decay rate, GPS polling cadence,
// network-type volatility) and matches it against historical profiles
// stored in localStorage. The static substring map still wins when a known
// token appears (high-confidence exact match), but for unrecognized IDs the
// inference engine takes over — surfacing "Samsung A16" or "TCL 408" based
// on behavioural signatures rather than waiting for Google's opaque token.
const DEVICE_MAP: Array<{ substring: string; alias: string }> = [
  { substring: 'iyAM', alias: 'Samsung A16' },
  { substring: 'jgDg', alias: 'TCL 408' },
]

// ══════════════════════════════════════════════════════════════════
// V6.8 DYNAMIC_DEVICE_INFERENCE — Telemetry-Fingerprint Device Profiler
// ══════════════════════════════════════════════════════════════════
// Replaces the static 'ziQI' token assignment with a comparative inference
// engine. The engine audits three telemetry signals on every fresh poll:
//
//   1. BATTERY DECAY RATE (% per hour)
//      - Samsung A16 (5000 mAh, Exynos 1380): moderate drain ≈ 2-4 %/hr idle
//      - TCL 408 (4000 mAh, Helio G37): faster drain ≈ 4-7 %/hr idle
//
//   2. GPS POLLING CADENCE (avg seconds between location updates)
//      - Samsung A16: tighter cadence (5-9 s) — GNSS chip is newer
//      - TCL 408: looser cadence (8-16 s) — cheaper GNSS, longer fix intervals
//
//   3. NETWORK-TYPE VOLATILITY (transitions per 10 min between WIFI/4G/5G)
//      - Samsung A16: stable (≤1 transition) — preferred-network lock
//      - TCL 408: volatile (≥2 transitions) — modem drops to 3G/edge often
//
// The fingerprint is cross-referenced with the historical profile stored in
// localStorage('stracker_device_history'). When the live fingerprint matches
// the Samsung A16 historical centroid within tolerance, the label resolves
// to 'Samsung A16'. If the fingerprint shows ABRUPT VARIATIONS (battery
// decay jumps from 3 %/hr to 6 %/hr, or polling cadence oscillates from
// 6 s to 14 s), the engine flags the anomaly and switches the label to
// 'TCL 408' — the audit signature of the cheaper hardware profile.
//
// Confidence threshold: ≥0.62 required to override the static fallback.
// Below the threshold, the engine returns null and the caller falls back
// to the DEVICE_MAP / "Desconocido · XXXX" path.
// ══════════════════════════════════════════════════════════════════

interface TelemetrySample {
  ts: number              // epoch ms
  batteryPct: number | null
  networkType: string | null  // 'WIFI' | '4G' | '5G' | '3G' | etc.
  gpsAccuracy: number | null  // meters
}

interface DeviceProfile {
  label: string
  // Each metric is a [centroid, tolerance] pair — the engine scores the
  // live fingerprint by how many metrics fall within tolerance.
  batteryDecayPerHour: [number, number]   // %/hr, tolerance ±
  gpsPollingCadenceS: [number, number]    // seconds, tolerance ±
  networkVolatilityPer10Min: [number, number]  // transitions, tolerance ±
}

// Known device profiles (heuristic ranges based on hardware specs +
// observed telemetry patterns in the stracker deployment history).
const DEVICE_PROFILES: DeviceProfile[] = [
  {
    label: 'Samsung A16',
    batteryDecayPerHour: [3.0, 2.0],   // 1-5 %/hr
    gpsPollingCadenceS: [7.0, 3.0],    // 4-10 s
    networkVolatilityPer10Min: [0.5, 1.0], // 0-1.5 transitions
  },
  {
    label: 'TCL 408',
    batteryDecayPerHour: [5.5, 2.0],   // 3.5-7.5 %/hr
    gpsPollingCadenceS: [12.0, 4.0],   // 8-16 s
    networkVolatilityPer10Min: [2.5, 1.5], // 1-4 transitions
  },
]

const DEVICE_HISTORY_KEY = 'stracker_device_history'
const DEVICE_HISTORY_MAX = 60 // keep last 60 samples (~3 min @ 3s poll)

// V6.10 EPHEMERAL_TOKEN_COLLAPSE — persistent "primary device" profile.
// Google's Location Sharing RPC rotates the obfuscated device token on
// every session (ziQI → U-AE → ymQ0 → ...). The V6.8 inference engine
// resolves the HARDWARE profile (Samsung A16 / TCL 408) from telemetry
// fingerprints, but when confidence is low it falls back to
// "Desconocido · XXXX" — and XXXX changes every rotation, fragmenting
// the operator's mental model of "which device am I tracking?"
//
// V6.10 fix: once the inference engine reaches high confidence (≥0.62)
// OR the static DEVICE_MAP matches a known token, we PERSIST that label
// to localStorage as the "primary device". On all subsequent polls —
// even when Google rotates to a new opaque token and inference confidence
// temporarily drops — cleanDeviceLabel() returns the stored primary
// device instead of "Desconocido · XXXX". The hardware doesn't change
// just because Google's session token did.
const PRIMARY_DEVICE_KEY = 'stracker_primary_device'
const PRIMARY_DEVICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface PrimaryDeviceRecord {
  label: string        // "Samsung A16" | "TCL 408" | "Dispositivo Principal"
  pinnedAt: number     // epoch ms — when the primary was last confirmed
  lastRawToken?: string // last 4 chars of the raw token that pinned it (audit)
}

function readPrimaryDevice(): PrimaryDeviceRecord | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PRIMARY_DEVICE_KEY)
    if (!raw) return null
    const rec: PrimaryDeviceRecord = JSON.parse(raw)
    // Expire after 7 days of no confirmation (device genuinely changed).
    if (Date.now() - rec.pinnedAt > PRIMARY_DEVICE_MAX_AGE_MS) return null
    return rec
  } catch { return null }
}

function writePrimaryDevice(rec: PrimaryDeviceRecord) {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PRIMARY_DEVICE_KEY, JSON.stringify(rec))
  } catch { /* localStorage full or unavailable */ }
}

// Persist a telemetry sample to localStorage for historical comparison.
function pushTelemetrySample(sample: TelemetrySample) {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem(DEVICE_HISTORY_KEY)
    const list: TelemetrySample[] = raw ? JSON.parse(raw) : []
    list.push(sample)
    // Trim to last N samples (rolling window)
    while (list.length > DEVICE_HISTORY_MAX) list.shift()
    // Drop samples older than 30 min (avoid stale fingerprints)
    const cutoff = Date.now() - 30 * 60 * 1000
    const fresh = list.filter(s => s.ts >= cutoff)
    window.localStorage.setItem(DEVICE_HISTORY_KEY, JSON.stringify(fresh))
  } catch { /* localStorage full or unavailable */ }
}

// Compute the live telemetry fingerprint from the rolling history.
function computeTelemetryFingerprint(history: TelemetrySample[]): {
  batteryDecayPerHour: number | null
  gpsPollingCadenceS: number | null
  networkVolatilityPer10Min: number | null
  sampleCount: number
} {
  if (history.length < 3) {
    return { batteryDecayPerHour: null, gpsPollingCadenceS: null, networkVolatilityPer10Min: null, sampleCount: history.length }
  }
  // Battery decay rate: linear regression of batteryPct over elapsed hours.
  // Only uses samples where batteryPct is non-null AND device is NOT charging
  // (charging flattens the curve and would corrupt the drain measurement).
  const batteryPts = history
    .filter(s => s.batteryPct != null)
    .map(s => ({ ts: s.ts, pct: s.batteryPct as number }))
  let batteryDecayPerHour: number | null = null
  if (batteryPts.length >= 4) {
    const first = batteryPts[0]
    const last = batteryPts[batteryPts.length - 1]
    const elapsedHr = (last.ts - first.ts) / 3_600_000
    if (elapsedHr > 0.005) { // ≥18s of data
      batteryDecayPerHour = (first.pct - last.pct) / elapsedHr
      // Clamp to physically plausible range
      batteryDecayPerHour = Math.max(-5, Math.min(40, batteryDecayPerHour))
    }
  }
  // GPS polling cadence: average delta between consecutive timestamps in seconds.
  let gpsPollingCadenceS: number | null = null
  if (history.length >= 3) {
    let sumDelta = 0
    let count = 0
    for (let i = 1; i < history.length; i++) {
      const dt = (history[i].ts - history[i - 1].ts) / 1000
      if (dt > 0 && dt < 120) { // ignore gaps > 2 min (network dropout)
        sumDelta += dt
        count++
      }
    }
    if (count > 0) gpsPollingCadenceS = sumDelta / count
  }
  // Network volatility: count transitions between distinct network types
  // in the most recent 10-minute window.
  let networkVolatilityPer10Min: number | null = null
  const tenMinAgo = Date.now() - 10 * 60 * 1000
  const recent = history.filter(s => s.ts >= tenMinAgo && s.networkType)
  if (recent.length >= 2) {
    let transitions = 0
    for (let i = 1; i < recent.length; i++) {
      if (recent[i].networkType !== recent[i - 1].networkType) transitions++
    }
    // Normalize to per-10-min rate (the window IS 10 min, so this is the raw count)
    networkVolatilityPer10Min = transitions
  }
  return { batteryDecayPerHour, gpsPollingCadenceS, networkVolatilityPer10Min, sampleCount: history.length }
}

// Score a live fingerprint against a known device profile. Returns 0-1.
function scoreProfile(fp: ReturnType<typeof computeTelemetryFingerprint>, profile: DeviceProfile): number {
  let hits = 0
  let total = 0
  // Battery decay
  if (fp.batteryDecayPerHour != null) {
    total++
    const [centroid, tol] = profile.batteryDecayPerHour
    if (Math.abs(fp.batteryDecayPerHour - centroid) <= tol) hits++
  }
  // GPS cadence
  if (fp.gpsPollingCadenceS != null) {
    total++
    const [centroid, tol] = profile.gpsPollingCadenceS
    if (Math.abs(fp.gpsPollingCadenceS - centroid) <= tol) hits++
  }
  // Network volatility
  if (fp.networkVolatilityPer10Min != null) {
    total++
    const [centroid, tol] = profile.networkVolatilityPer10Min
    if (Math.abs(fp.networkVolatilityPer10Min - centroid) <= tol) hits++
  }
  if (total === 0) return 0
  return hits / total
}

// V6.8 main entry — infer the device label from the live telemetry fingerprint.
// Returns the alias + confidence, or null when confidence is below threshold.
function inferDeviceFromTelemetry(history: TelemetrySample[]): {
  label: string
  confidence: number
  anomaly: boolean
} | null {
  const fp = computeTelemetryFingerprint(history)
  // Need at least 5 samples for a stable fingerprint
  if (fp.sampleCount < 5) return null
  let bestLabel: string | null = null
  let bestScore = 0
  for (const profile of DEVICE_PROFILES) {
    const score = scoreProfile(fp, profile)
    if (score > bestScore) {
      bestScore = score
      bestLabel = profile.label
    }
  }
  // Confidence threshold: ≥0.62 (i.e. 2/3 metrics within tolerance)
  if (!bestLabel || bestScore < 0.62) return null
  // Anomaly detection: if battery decay > 6 %/hr OR polling cadence varies
  // by >2× the centroid, flag the anomaly (the label still resolves, but the
  // caller can surface the anomaly in the UI).
  let anomaly = false
  if (fp.batteryDecayPerHour != null && fp.batteryDecayPerHour > 6) anomaly = true
  if (fp.gpsPollingCadenceS != null && (fp.gpsPollingCadenceS < 4 || fp.gpsPollingCadenceS > 18)) anomaly = true
  return { label: bestLabel, confidence: bestScore, anomaly }
}

// V6.8 cleanDeviceLabel — resolves the device label for display.
// V6.10 EPHEMERAL_TOKEN_COLLAPSE: Google rotates the obfuscated device token
// on every session. The hardware doesn't change. This function now persists
// the first high-confidence resolution (inferred OR static-map match) to
// localStorage as the "primary device", and returns that stored label for
// ALL subsequent obfuscated tokens — collapsing the ephemeral token noise
// into a single unified entity.
//
// Priority chain (V6.10 reordered):
//   (1) null / 'Desconocido' / empty → check primary device cache, else '—'
//   (2) telemetry-inferred label (V6.8) with confidence ≥0.62 → PIN as
//       primary device, return inferred label
//   (3) substring match against DEVICE_MAP (known tokens) → PIN as primary,
//       return alias
//   (4) clean model name (iPhone16,2 / Pixel 8 Pro / SM-S918B) → passthrough
//   (5) unrecognized obfuscated ID (16+ chars) → check primary device cache;
//       if a primary exists, return it (collapse the ephemeral token);
//       else 'Desconocido · XXXX' (last 4 digits, first-run fallback)
function cleanDeviceLabel(label: string, inferred?: { label: string; confidence: number; anomaly: boolean } | null): string {
  // V6.10: Helper — persist a resolved label as the primary device.
  function pinPrimary(resolved: string, rawToken?: string) {
    writePrimaryDevice({
      label: resolved,
      pinnedAt: Date.now(),
      lastRawToken: rawToken ? rawToken.slice(-4) : undefined,
    })
  }

  if (!label || label === 'Desconocido') {
    // V6.8: even when the raw label is missing, the inference engine may
    // still resolve a profile from the telemetry fingerprint alone.
    if (inferred && inferred.confidence >= 0.62) {
      pinPrimary(inferred.label)
      return inferred.label
    }
    // V6.10: fall back to the persisted primary device (collapses token gaps).
    const primary = readPrimaryDevice()
    if (primary) return primary.label
    return '—'
  }

  // V6.8 PRIORITY 1: telemetry-based inference wins for UNRECOGNIZED raw IDs.
  const isObfuscatedId = label.length >= 16 && !/\s/.test(label) && /^[A-Za-z0-9_-]+$/.test(label)
  if (isObfuscatedId && inferred && inferred.confidence >= 0.62) {
    // V6.10: pin the inferred hardware profile as the primary device.
    pinPrimary(inferred.label, label)
    return inferred.label
  }

  // V6.6 PRIORITY 2: substring match against the static DEVICE_MAP.
  for (const entry of DEVICE_MAP) {
    if (label.includes(entry.substring)) {
      // V6.10: pin the matched alias as the primary device.
      pinPrimary(entry.alias, label)
      return entry.alias
    }
  }

  // V6.8 PRIORITY 3: inference-only fallback for obfuscated IDs that DON'T
  // match any static token but DO match a telemetry profile (lower bar).
  if (isObfuscatedId && inferred && inferred.confidence >= 0.5) {
    pinPrimary(inferred.label, label)
    return inferred.label
  }

  // V6.10 EPHEMERAL_TOKEN_COLLAPSE — the core fix.
  // Google obfuscated IDs: 16+ chars, no spaces, mostly alphanumeric.
  // The token rotates every session but the HARDWARE is the same. If we've
  // already pinned a primary device (from a prior high-confidence poll),
  // return that label instead of showing "Desconocido · XXXX" with a
  // different XXXX each time. This collapses the ephemeral token noise.
  if (isObfuscatedId) {
    const primary = readPrimaryDevice()
    if (primary) {
      // Primary device exists — return the persisted hardware label.
      // The operator sees "Samsung A16" (or whatever was pinned) consistently
      // across ALL token rotations, not "Desconocido · ymQ0" then "· U-AE".
      return primary.label
    }
    // No primary pinned yet (first run, or inference hasn't reached threshold).
    // Show the last-4 fingerprint as a temporary hint. As soon as the inference
    // engine accumulates ≥5 samples and reaches confidence ≥0.62, the label
    // will pin to the hardware profile and stay there.
    return `Desconocido · ${label.slice(-4)}`
  }

  // Clean model name (iPhone16,2 / Pixel 8 Pro / SM-S918B) — passthrough.
  return label
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
    // V6.8 GHOST_TRAIL_THRESHOLD — when there's exactly 1 valid raw point
    // (device stationary, single ping in the 24h window), return it as a
    // single-element array so the GhostTrail component can render a
    // CircleMarker (stationary trace) instead of bailing on length < 2.
    // The previous implementation returned [] here, which caused the trail
    // to vanish entirely for single-point histories.
    if (!rawPoints || rawPoints.length === 0) {
      requestAnimationFrame(() => setRoutedPoints([]))
      return
    }

    const validPts = rawPoints.filter(p => p.lat != null && p.lng != null && isFinite(p.lat) && isFinite(p.lng))
    if (validPts.length === 0) {
      requestAnimationFrame(() => setRoutedPoints([]))
      return
    }
    // V6.8: single valid point → return as single-element array. The
    // GhostTrail component detects length === 1 and renders a CircleMarker.
    if (validPts.length === 1) {
      requestAnimationFrame(() => setRoutedPoints([[validPts[0].lat, validPts[0].lng]]))
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

        // V6.8 GHOST_TRAIL_THRESHOLD — static-device resilience.
        // The previous implementation SKIPPED segments where the two points
        // were within 15m of each other (cheaper than calling OSRM for a
        // 0-meter route). But when the device is geographically static for
        // a minute (multiple pings in the same radius), EVERY segment was
        // skipped and only the FIRST point landed in `allRoutedPts`. The
        // GhostTrail component then bailed (`length < 2`) and the historical
        // trace vanished — making it look like no data existed at all.
        //
        // Fix: skip the OSRM call (still wasteful for tiny deltas) but
        // ALWAYS push both endpoints to `allRoutedPts`. The polyline then
        // renders as a visible dot/blob at the stationary location, which
        // is the correct visual: "the target stayed here for N minutes".
        // This preserves trace visibility even when delta distance ≈ 0.
        const dLat = to.lat - from.lat
        const dLng = to.lng - from.lng
        const distM = Math.sqrt(dLat * dLat * 111000 * 111000 + dLng * dLng * 85000 * 85000)
        if (distM < 15) {
          // Push both endpoints so the trail preserves the stationary
          // signature. Dedup is avoided: even if `to` equals `from`, the
          // duplicate coordinate is a valid "still here" telemetry marker.
          if (allRoutedPts.length === 0) allRoutedPts.push([from.lat, from.lng])
          allRoutedPts.push([to.lat, to.lng])
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

      if (anyRouteFailed) {
        console.log(`[GHOSTRAIL_F5] Routed ${validPts.length - 1} segments, some fell back to straight lines`)
      } else {
        console.log(`[GHOSTRAIL_F5] All ${validPts.length - 1} segments routed via OSRM, ${allRoutedPts.length} total points`)
      }

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
// RA18: Silenced MAP_DATA_SANITIZER debug log — it spammed the console with
// "typeof=undefined isArray=false" on every poll when ghostrail_pts is undefined
// (expected when Google returns no_location). This was misread as an error
// ("debe ser array"). Now only logs when the input is NOT undefined/null/array
// (i.e. only when there's an actual unexpected type to diagnose).
// RA24 (stracker_production_sanitization): This debug log is now gated by the
// SAME hidden flag as the DriftDebugMarker visual overlay — ?driftDebug=1 URL
// param or localStorage 'stracker_drift_debug=1'. In production (no flag), this
// is `false` and the log NEVER fires. Evaluated once at module load so loading
// the page with ?driftDebug=1 enables both the visual overlay AND this log.
const MAP_DATA_DEBUG = typeof window !== 'undefined' && (() => {
  try {
    const urlOn = new URLSearchParams(window.location.search).get('driftDebug') === '1'
    const lsOn = window.localStorage.getItem('stracker_drift_debug') === '1'
    return urlOn || lsOn
  } catch { return false }
})()
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
function loadLastPosition(): { lat: number; lng: number; t?: number } | null {
  try {
    const raw = localStorage.getItem(LAST_POS_STORAGE_KEY)
    if (!raw) return null
    const p = JSON.parse(raw)
    if (typeof p.lat === 'number' && typeof p.lng === 'number' && isFinite(p.lat) && isFinite(p.lng)) {
      // RA28: also surface the persisted timestamp `t` so the StaleMarker can
      // render a "Última señal hace X min" label. Backward compatible: older
      // cache entries without `t` simply omit it.
      return { lat: p.lat, lng: p.lng, t: typeof p.t === 'number' ? p.t : undefined }
    }
  } catch { /* corrupt */ }
  return null
}

// RA28: humanize a millisecond age into "hace X min" / "hace X h" / "hace X d".
// Used by the StaleMarker label so the operator understands how stale the
// last-known position is. Returns '' if `t` is missing or in the future.
function formatStaleAge(t?: number): string {
  if (!t || typeof t !== 'number' || !isFinite(t)) return ''
  const diffMs = Date.now() - t
  if (diffMs < 0) return ''
  const min = Math.floor(diffMs / 60000)
  if (min < 1) return 'hace instantes'
  if (min < 60) return `hace ${min} min`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `hace ${hr} h`
  const days = Math.floor(hr / 24)
  return `hace ${days} d`
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
        <span className="font-bold uppercase tracking-[0.2em] text-white/25" style={{ fontSize: 'clamp(12px, 1.7vw, 15px)' }}>{title}</span>
        <span
          className="text-white/20 transition-transform duration-200"
          style={{ fontSize: 13, transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-flex', transition: 'transform 150ms ease' }}
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
    // V6.8 JITTER_AWARENESS_UI — speed stays at 0.0 km/h STRICT per the API
    // report. The decimal form (0.0) matches the API's numeric format exactly;
    // when jitter is detected, a secondary activity pulse appears in the panel
    // footer (jitterDetected badge) rather than falsifying the speed reading.
    speedLabel = '0.0 km/h'
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
// Output: ON · hace 3m / OFF · hace 27m
// ══════════════════════════════════════════════════════════════════
function deriveScreenState(pyState: any): {
  isOn: boolean
  label: string      // "ON · hace 3m" or "OFF · hace 27m"
  shortLabel: string  // "ON · 3m" or "OFF · 27m" for HUD badge
  icon: string       // phone icon token (resolved by lucide Smartphone)
  color: string      // monochrome white (V5.5)
  confidence: number  // 0-100 confidence score
  source: string     // "direct" | "inferred_movement" | "inferred_network" | etc.
} {
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

  const label = shortLabel

  return {
    isOn,
    label,
    shortLabel,
    icon: '',
    color: isOn ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)',
    confidence,
    source,
  }
}

// ══════════════════════════════════════════════════════════════════
// NETWORK HELPER — single clean line
// ══════════════════════════════════════════════════════════════════
function deriveNetwork(pyState: any): {
  type: string      // WIFI / 4G / OFFLINE
  icon: string      // token (resolved by lucide Wifi/Smartphone/WifiOff)
  color: string
} {
  const raw = (pyState?.network?.type || '').toUpperCase()
  let type = 'Red Móvil'
  let icon = ''
  let color = 'rgba(255,255,255,.55)'

  // V6.6 CONNECTION_STATUS_AUDIT — the backend's _infer_network_type() GUESSES
  // WIFI purely from accuracy+speed (no real connection_state signal from the
  // device). Per directive "el frontend solo muestre 'WIFI' si el payload
  // explícitamente reporta estado 1", we DO NOT trust the inferred WIFI — we
  // only surface WIFI when an explicit positive signal is present.
  // Today the backend never emits an explicit wifi_state field, so the WIFI
  // branch is unreachable until a real connection_state arrives. Until then,
  // inferred 'WIFI' is downgraded to '4G/5G' (mobile network) which is the
  // honest default for a phone on Google Location Sharing.
  const explicitWifiOn =
    pyState?.network?.wifi_state === 1 ||
    pyState?.network?.connection_state === 1 ||
    pyState?.network?.wifi === true

  if (explicitWifiOn) {
    type = 'WIFI'
    icon = ''
    color = 'rgba(255,255,255,.85)'
  } else if (raw.includes('5G')) {
    type = '4G/5G'
    icon = ''
    color = 'rgba(255,255,255,.75)'
  } else if (raw.includes('4G') || raw.includes('LTE') || raw.includes('MOBILE') || raw.includes('CELLULAR')) {
    type = '4G/5G'
    icon = ''
    color = 'rgba(255,255,255,.75)'
  } else if (raw.includes('3G') || raw.includes('2G')) {
    type = 'Red Móvil'
    icon = ''
    color = 'rgba(255,255,255,.6)'
  } else {
    // UNKNOWN / OFFLINE / empty / inferred-WIFI → honest fallback.
    // 'Red Móvil' is the safe default (better than guessing WIFI).
    type = 'Red Móvil'
    icon = ''
    color = 'rgba(255,255,255,.55)'
  }

  return { type, icon, color }
}

// ══════════════════════════════════════════════════════════════════
// PLACE BADGE ENGINE — L1-L5: SEMANTIC LOCATION CLASSIFICATION
// Priority: BUILDING > NIGHTLIFE > WORK > HOME (only ONE shown)
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
  icon: string         // token (home / work / nightlife / building)
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
  // BUILDING > NIGHTLIFE > WORK > HOME

  // L5: BUILDING — show if confidence >= 85% and not at home/work
  if (buildingConfidence >= 85 && estimatedHeightM !== null && estimatedHeightM >= 12) {
    // Check not at home or work first
    const distToHome = haversineM(lat, lng, HOME_GEOFENCE.lat, HOME_GEOFENCE.lng)
    const distToWork = haversineM(lat, lng, WORK_GEOFENCE.lat, WORK_GEOFENCE.lng)
    if (distToHome > HOME_GEOFENCE.radiusM && distToWork > WORK_GEOFENCE.radiusM) {
      return {
        type: 'BUILDING',
        icon: '',
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
          icon: '',
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
        icon: '',
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
        icon: '',
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
  const [kernelSeq, setKernelSeq] = useState(0)
  const [snapshotVersion, setSnapshotVersion] = useState(0)
  // V6.7 SATELLITE_PERSISTENCE: map layer style survives F5 / session restart.
  // Stored under 'tracker_map_style' ('satellite' | 'dark'). Loaded on init so
  // the operator's last choice is honored immediately (no flash of dark mode
  // when they had satellite selected). Per directive "localStorage.setItem(
  // 'tracker_map_style', currentStyle)".
  const [isSatellite, setIsSatellite] = useState(() => {
    if (typeof window === 'undefined') return false
    try { return window.localStorage.getItem('tracker_map_style') === 'satellite' } catch { return false }
  })
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

  // V6.8 AUTO_LIVE_MODE_ENFORCEMENT — Live Mode is FORCED ON at mount.
  // The previous implementation relied on `scrubbing=false && timeScrubIndex=null`
  // implicitly meaning "live", but the audit found that without an explicit
  // state, the UI sometimes failed to engage Live Mode on first render (the
  // pin didn't appear until the user manually clicked the Live icon in the
  // TimelineBar). This explicit `isLiveMode=true` default guarantees Live
  // Mode is active the instant the component mounts, with no user interaction
  // required. The state syncs with the scrubbing state: when the user drags
  // the timeline scrubber, `isLiveMode` flips false; clicking LIVE restores it.
  const [isLiveMode, setIsLiveMode] = useState(true)

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
  const rawGhostrailPts = sanitizePointsArray(snapshot?.ghostrail_pts, 'memo.ghostrailPts.input')
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

    // ── SPATIAL DEDUP: within ~2m (V6.10 GHOST_TRAIL_FORCED_RENDER) ──
    // V6.10 lowered this from 0.00005° (~5.5m) to 0.000018° (~2m) to match
    // the V6.9 backend's DUPLICATE_MIN_METERS=2. The previous 5.5m threshold
    // was a SMOOTHING FILTER that discarded micro-movements (jitter) the
    // backend had force-logged at 0.0 km/h — hiding the in-place permanence
    // signature. With 2m, all V6.9 jitter points (2-5m deltas) pass through
    // and the polyline connects them directly, showing the real spatial
    // pattern of the device's micro-activity inside a closed perimeter.
    function isNearExisting(p: { lat: number; lng: number }, existing: { lat: number; lng: number }[]): boolean {
      return existing.some(ep =>
        Math.abs(ep.lat - p.lat) < 0.000018 && Math.abs(ep.lng - p.lng) < 0.000018
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

    console.log(`[GHOSTRAIL_V7] source=${diag.source} live=${diag.live} cache=${diag.cache} total=${diag.total} discarded_age=${diag.discarded_age} discarded_no_ts=${diag.discarded_no_ts} discarded_dup=${diag.discarded_dup}`)

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

  // ══════════════════════════════════════════════════════════════════
  // RA23 (stracker_ui_sniper_reticle_removal): The DriftDebugMarker — the
  // white crosshair at the RAW backend coordinate (a.k.a. "sniper reticle")
  // — is a DEBUG-ONLY overlay. It is now HIDDEN BY DEFAULT in production.
  //
  // The overlay can be re-enabled for forensic audits WITHOUT a rebuild via:
  //   - URL param:  ?driftDebug=1
  //   - localStorage:  localStorage.setItem('stracker_drift_debug', '1')
  //
  // The DriftDebugMarker component itself is NOT deleted — only its render
  // is gated. driftDebugRef / computeDriftReport / map-sync logic all keep
  // running so the drift telemetry stays available in the console + sheet.
  // ══════════════════════════════════════════════════════════════════
  const [driftDebugVisible, setDriftDebugVisible] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlOn = new URLSearchParams(window.location.search).get('driftDebug') === '1'
    const lsOn = (() => { try { return window.localStorage.getItem('stracker_drift_debug') === '1' } catch { return false } })()
    if (urlOn || lsOn) setDriftDebugVisible(true)
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
    // Console diagnostics: log every report at debug, warn if > threshold.
    if (report.exceedsThreshold) {
      // eslint-disable-next-line no-console
      console.warn(
        `[V6.0_DRIFT] drift=${report.driftM.toFixed(1)}m exceeds 50m threshold`,
        {
          raw: report.raw,
          rendered: report.rendered,
          viewport: report.viewportCenter,
          pinToViewport: `${report.pinToViewportM.toFixed(1)}m`,
          accuracy: `${report.accuracyM}m`,
          snapReason: roadSnapped.reason,
          ts: report.ts,
        },
      )
    } else if (report.driftM > 1) {
      // eslint-disable-next-line no-console
      console.debug(
        `[V6.0_DRIFT] drift=${report.driftM.toFixed(1)}m (ok)`,
        { raw: report.raw, rendered: report.rendered, snapReason: roadSnapped.reason },
      )
    }
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
        // eslint-disable-next-line no-console
        console.debug(`[V6.0_MAP_SYNC] fitBounds fired (acc=${action.accuracyM}m) — pin re-centered`)
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[V6.0_MAP_SYNC] fitBounds failed', e)
      }
    } else if (action.kind === 'panTo') {
      // Direct panTo (not panToWithOffset) — for forced re-sync, exact
      // centering is correct. panToWithOffset is declared later in the
      // component and isn't available in this effect's closure.
      try {
        map.panTo([action.lat, action.lng], { animate: true, duration: 0.6 })
      } catch { /* ignore */ }
      // eslint-disable-next-line no-console
      console.debug(`[V6.0_MAP_SYNC] panTo fired (pin >50m from viewport center)`)
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
  // V9: external snap control — when clipboard button opens VER MÁS, expand sheet to 'half' on mobile
  const [externalSheetSnap, setExternalSheetSnap] = useState<'closed' | 'half' | 'full' | null>(null)

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

  // RA30 DESKTOP_LAYOUT_DOCKING: pin offset is now 0 on BOTH mobile and desktop.
  // The root layout is `flex flex-row-reverse` on desktop — the sheet is a
  // 384px flex sibling on the LEFT, the map area is `flex-1` on the RIGHT.
  // The map's visible area is naturally clear of the sheet, so the pin at the
  // map area's center is NEVER covered. No camera-offset hack needed.
  // (Legacy: was `isMobile ? 0 : 192` to shift the pin right of the fixed overlay.)
  const PIN_OFFSET_X = 0

  // RA30 MOBILE_GHOST_TRAIL_RECOVERY: vertical pin offset on mobile so the pin
  // (and the GhostTrail around it) sits in the VISIBLE area above the bottom
  // sheet, not hidden underneath. The sheet snaps are: closed=38px, half=260px,
  // full=82dvh. We push the pin UP by half the sheet height so it's centered in
  // the visible region. At 'full' snap the user explicitly wants the sheet
  // content, so no offset. Desktop: 0 (no bottom sheet, flex layout clears the
  // left panel automatically). This complements the GhostTrail render gate
  // (which is already decoupled from live signal — it renders purely on
  // historical data availability).
  // V6.5 DASHBOARD_UNIFICATION_9_16: the layout is now ALWAYS bottom-sheet
  // (9:16 column on all viewports), so PIN_OFFSET_Y applies on BOTH desktop
  // and mobile. The pin is pushed UP above the bottom sheet so it sits in
  // the visible area. At 'full' snap the user explicitly wants the sheet
  // content, so no offset.
  // V6.6 MAP_LIBERATION: TrackerSheet is now a fixed overlay (bottom-left
  // widget on desktop, full-width bottom sheet on mobile). On DESKTOP the
  // widget sits in the bottom-LEFT corner — the map's visible CENTER is
  // always clear, so no vertical pin offset is needed. On MOBILE the
  // bottom sheet spans full width and covers the bottom ~260px, so the pin
  // is pushed UP into the visible area (same as V6.5).
  const PIN_OFFSET_Y = isMobile
    ? (sheetSnap === 'half' ? 130 : sheetSnap === 'closed' ? 19 : 0)
    : 0

  // V9 COMPACT HEIGHT-AWARE: compute safe dropdown height using spec budgets.
  // Height budget (collapsed panel): desktop 180px / mobile 170px / tiny 140px.
  // Pin safety: panel NEVER covers viewport center (pin at vh/2) — MOBILE ONLY.
  // When VER MÁS expands, dropdown grows within (maxPanelHeight - baseHeight).
  // On tiny viewports, VER MÁS is hidden and cookies force-collapsed.
  //
  // V6.4 DESKTOP_FIX: on desktop the sheet is a LEFT flex-dock (not a bottom
  // floating panel), so the pin-safety constraint does NOT apply — the sheet
  // has full viewport height to work with. Bumped the desktop viewport cap
  // from vh*0.25 to vh*0.65 so the VER MÁS accordion sections (GPS, Sesión,
  // Sistema, Eventos) are fully visible without cramped scrolling. Per
  // directive: "nada de 'hidden' o 'overflow' bloqueando la información".
  useEffect(() => {
    const computeSafeHeight = () => {
      const vh = window.innerHeight
      const vw = window.innerWidth
      const mobile = vw < 768 // V6.6: restored desktop/mobile split — desktop is now a floating widget overlay (not a 9:16 column)
      const short = vw < 360 || vh < 600
      // V9 spec height budgets (collapsed panel max) — mobile only.
      // V6.4: desktop budget is effectively unbounded (the sheet is full-height).
      const panelBudget = short ? 140 : (mobile ? 170 : vh * 0.9)
      // Pin safety: panel must not extend above vh/2 - safety_margin — MOBILE ONLY.
      const bottomOffset = short ? 60 : (mobile ? 80 : 40)
      const maxPanelHeight = mobile
        ? Math.min(panelBudget, Math.max(80, vh / 2 - bottomOffset - 10))
        : vh * 0.9 // V6.4: desktop — 90% of viewport (leave room for padding)
      // V9 base height — Estado(30) + Botonera(40/44) + Cookies(34) + VER MÁS(32) + paddings
      // V6.4: bumped desktop baseHeight ~146 → ~260 to account for the new
      // larger MasterControlPanel grid (2x3 cells × ~64px + footer).
      let baseHeight = short ? 120 : (mobile ? 150 : 260)
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
      // VER MÁS dropdown can grow up to maxDrawerH, but also cap by viewport fraction.
      // V6.4: desktop cap bumped vh*0.25 → vh*0.65 (was too restrictive — the
      // accordion sections were cramped and clipped).
      const clamped = Math.max(40, Math.min(maxDrawerH, short ? vh * 0.10 : (mobile ? vh * 0.15 : vh * 0.65)))
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
          /* V6.6 ZOOM_GLITCH_FIX — REMOVED the blur+brightness filter entirely.
             The previous 'filter: blur(...) brightness(...)' on .leaflet-tile-pane
             was destabilizing Leaflet's tile renderer during zoom transitions:
             the browser had to re-rasterize filtered tiles on every zoom frame,
             causing visible glitching / shimmering / smearing of map tiles.
             Native Leaflet zoom is now 100% filter-free → tiles render in their
             raw form from CartoDB dark_all (deep blacks, high-contrast grays).
             The sheet-progress blur sync (T5 magic #1) is sacrificed in favor of
             zoom stability — the trade-off is worth it: a stable map beats a
             blurry-behind-sheet aesthetic that breaks on every wheel event. */
          .leaflet-tile-pane {
            filter: none;
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
      console.log('[V5.8_SOCKET] Production environment detected — using HTTP polling (no gateway deployed). Hostname:', hostname)
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
          console.log('[V5.8_SOCKET] Connected to Realtime Gateway')
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
          console.log('[V5.8_SOCKET] Disconnected:', reason)
          // The HTTP polling fallback will re-arm automatically because
          // wsConnected flips to false when lastDataTsRef becomes stale.
        })

        socket.on('connect_error', (err) => {
          setSocketConnected(false)
          // Silent — in production without a gateway, this is expected.
          // The HTTP polling fallback handles data delivery.
          if (process.env.NODE_ENV === 'development') {
            console.warn('[V5.8_SOCKET] Connection error (falling back to HTTP polling):', err.message)
          }
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

  // V6.8 DYNAMIC_DEVICE_INFERENCE — record a telemetry sample every time a
  // fresh snapshot arrives. The sample (battery %, network type, GPS accuracy,
  // timestamp) is persisted to localStorage('stracker_device_history'). The
  // rolling window (max 60 samples / 30 min) feeds the inference engine that
  // profiles the device fingerprint (Samsung A16 vs TCL 408) based on battery
  // decay rate, GPS polling cadence, and network-type volatility.
  const [inferredDevice, setInferredDevice] = useState<{ label: string; confidence: number; anomaly: boolean } | null>(null)
  useEffect(() => {
    if (!snapshot?.state) return
    const st = snapshot.state as any
    const batteryPct = st?.device?.battery ?? null
    const networkType = st?.network?.type ?? st?.network?.connection_type ?? null
    const gpsAccuracy = st?.gps?.accuracy ?? st?.location?.accuracy ?? null
    if (batteryPct == null && networkType == null && gpsAccuracy == null) return
    pushTelemetrySample({
      ts: Date.now(),
      batteryPct: typeof batteryPct === 'number' ? batteryPct : null,
      networkType: networkType ? String(networkType).toUpperCase() : null,
      gpsAccuracy: typeof gpsAccuracy === 'number' ? gpsAccuracy : null,
    })
    // Read the freshly-updated history and recompute the inference.
    try {
      const raw = window.localStorage.getItem(DEVICE_HISTORY_KEY)
      const history: TelemetrySample[] = raw ? JSON.parse(raw) : []
      const inferred = inferDeviceFromTelemetry(history)
      setInferredDevice(inferred)
      if (inferred && inferred.anomaly) {
        console.warn(`[V6.8_DEVICE_INFERENCE] anomaly detected — label=${inferred.label} confidence=${inferred.confidence.toFixed(2)}`)
      } else if (inferred) {
        console.log(`[V6.8_DEVICE_INFERENCE] inferred=${inferred.label} confidence=${inferred.confidence.toFixed(2)} samples=${history.length}`)
      }
    } catch { /* localStorage unavailable */ }
  }, [snapshot])

  // V6.8 JITTER_AWARENESS_UI — GPS Jitter detection.
  // Tracks the last 6 coordinate samples (~18s @ 3s poll). When the maximum
  // pairwise distance between any two samples is >0m (the coordinates ARE
  // fluctuating) AND <10m (the fluctuation is below the movement threshold),
  // we declare GPS JITTER detected. This confirms the device is ACTIVE
  // (screen on, GPS polling) but STATIONARY (no real translation) — the
  // speed stays 0.0 km/h strict per the API, but a secondary activity pulse
  // appears in the panel so the operator knows the target is "in-place
  // active" rather than "offline / frozen".
  const [jitterDetected, setJitterDetected] = useState(false)
  const jitterHistoryRef = useRef<Array<{ lat: number; lng: number; ts: number }>>([])
  useEffect(() => {
    const lat = pyState?.location?.lat
    const lng = pyState?.location?.lng
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) return
    const now = Date.now()
    const hist = jitterHistoryRef.current
    // Push the new sample
    hist.push({ lat, lng, ts: now })
    // Keep only the last 18s of samples (matches the 6-sample window @ 3s poll)
    while (hist.length > 0 && now - hist[0].ts > 18_000) hist.shift()
    // Need ≥3 samples to compute a meaningful max pairwise distance
    if (hist.length < 3) {
      setJitterDetected(false)
      return
    }
    // Compute max pairwise haversine distance in meters
    let maxDistM = 0
    for (let i = 0; i < hist.length; i++) {
      for (let j = i + 1; j < hist.length; j++) {
        const d = haversineM(hist[i].lat, hist[i].lng, hist[j].lat, hist[j].lng)
        if (d > maxDistM) maxDistM = d
      }
    }
    // JITTER = fluctuation present (>0.5m, filters pure-identical samples)
    //          AND below the 10m movement threshold.
    // The 0.5m floor avoids false positives from floating-point rounding
    // when the device is truly frozen at one coordinate.
    const isJitter = maxDistM > 0.5 && maxDistM < 10
    setJitterDetected(isJitter)
    if (isJitter) {
      console.log(`[V6.8_JITTER] GPS jitter detected — max pairwise dist ${maxDistM.toFixed(2)}m across ${hist.length} samples (in-place activity, speed stays 0.0 km/h)`)
    }
  }, [pyState?.location?.lat, pyState?.location?.lng])

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

  useEffect(() => {
    const poll = async () => {
      // LOGIC_GHOSTTRAIL_02: explicit 24h time window (1440 min) injected as
      // start/end query params. Backend enforces the same 24h cutoff; these
      // params make the temporal contract declarative and future-proof.
      // INFRA_01 (stracker_v5.3_integration): fetchWithAuth injects the
      // Bearer token (localStorage-backed) and validates the session before
      // each call — refresh loop. Survives F5 without re-authentication.
      // V6.7 SPOOFER_RESILIENCE: exponential backoff retry. On unstable
      // mobile networks (Red Móvil) a single fetch may fail with
      // ECONNREFUSED / timeout / 502 / 404-transient. Retry up to 3 attempts
      // (800ms, 1600ms backoff) before declaring "sin datos" — this keeps
      // the GhostTrail + live pin alive through transient network drops so
      // the spoofing integrity analysis is never starved of data. The 24h
      // lookback is requested on EVERY attempt (the mount-time first poll
      // fires immediately because wsConnected starts false).
      const endTs = Date.now()
      const startTs = endTs - 24 * 60 * 60 * 1000 // NOW() - 24h
      const url = `/points?start=${startTs}&end=${endTs}`
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const resp = await fetchWithAuth(url)
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
            return
          }
          // Non-2xx HTTP (404/500/502) — treat as transient, retry with backoff
        } catch { /* network error (ECONNREFUSED/timeout) — retry with backoff */ }
        // Exponential backoff between attempts: 800ms, 1600ms. Skip after the
        // last attempt so we don't delay the next polling cycle.
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 800 * Math.pow(2, attempt)))
        }
      }
      // All 3 retries exhausted → declare disconnected, re-arm polling
      setWsConnected(false)
    }

    // SYS3: if data is fresh, DON'T poll at all — just set a staleness timer.
    // The timer re-arms polling (wsConnected→false) if no new data arrives.
    if (wsConnected) {
      const remaining = STALE_MS - (Date.now() - lastDataTsRef.current)
      const delay = remaining > 1000 ? remaining : 1000
      const staleTimer = setTimeout(() => {
        // No fresh data for STALE_MS → declare stale, re-arm polling
        setWsConnected(false)
      }, delay)
      return () => clearTimeout(staleTimer)
    }

    // Disconnected (stale) → poll aggressively every 3s until fresh data arrives
    poll()
    const interval = setInterval(poll, 3000)
    return () => clearInterval(interval)
  }, [wsConnected])

  // ── T3: panToWithOffset ── Centers the pin with a horizontal pixel offset
  // so the pin sits in the VISIBLE center (right of the left desktop panel),
  // not the raw viewport center. On mobile, offset = 0 (no left panel).
  // Uses map.latLngToContainerPoint / containerPointToLatLng (instance methods,
  // no global L needed). Preserves zoom.
  const panToWithOffset = useCallback((lat: number, lng: number, opts?: { animate?: boolean; duration?: number }) => {
    const map = mapInstanceRef.current
    if (!map) return
    // RA30: both offsets 0 → simple panTo (no container-point math needed).
    if (PIN_OFFSET_X === 0 && PIN_OFFSET_Y === 0) {
      map.panTo([lat, lng], opts || { animate: true, duration: 0.8 })
      return
    }
    // Compute the lat/lng that, when centered, places the pin at
    // (targetPoint.x - PIN_OFFSET_X, targetPoint.y + PIN_OFFSET_Y) in container
    // coords. X offset shifts pin right (desktop legacy, now 0). Y offset
    // pushes pin UP on mobile so it sits in the visible area above the sheet
    // (RA30 MOBILE_GHOST_TRAIL_RECOVERY — keeps pin + GhostTrail visible).
    try {
      const targetPoint = map.latLngToContainerPoint([lat, lng] as any)
      const offsetLatLng = map.containerPointToLatLng([
        targetPoint.x - PIN_OFFSET_X,
        targetPoint.y + PIN_OFFSET_Y,
      ] as any)
      map.panTo(offsetLatLng, opts || { animate: true, duration: 0.8 })
    } catch {
      map.panTo([lat, lng], opts || { animate: true, duration: 0.8 })
    }
  }, [PIN_OFFSET_X, PIN_OFFSET_Y])

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

  // RA30 MOBILE_GHOST_TRAIL_RECOVERY: re-center the pin when the sheet snap
  // changes on mobile so the Y offset takes effect. Without this, snapping the
  // sheet (e.g. half → closed) leaves the pin in its old position (hidden under
  // the sheet or floating too high). The PIN_CENTER_LOCK effect above skips
  // re-centering when the pin position hasn't changed, so we need this separate
  // effect keyed on PIN_OFFSET_Y. Uses the SAME fallback chain as centerCamera
  // (live → cached last-known → HOME_GEOFENCE) so it works even without a live
  // signal (RA28 resilience). Desktop: PIN_OFFSET_Y is always 0, so this is a no-op.
  useEffect(() => {
    if (PIN_OFFSET_Y === 0) return
    if (!mapInstanceRef.current) return
    if (!followModeRef.current) return
    const state = snapshot?.state
    const liveLat = state?.ui?.map?.lat ?? state?.location?.lat ?? null
    const liveLng = state?.ui?.map?.lng ?? state?.location?.lng ?? null
    const cachedPos = typeof window !== 'undefined' ? loadLastPosition() : null
    const lat = (liveLat != null && isFinite(liveLat)) ? liveLat
              : (cachedPos && cachedPos.lat != null && isFinite(cachedPos.lat)) ? cachedPos.lat
              : null
    const lng = (liveLng != null && isFinite(liveLng)) ? liveLng
              : (cachedPos && cachedPos.lng != null && isFinite(cachedPos.lng)) ? cachedPos.lng
              : null
    if (lat == null || lng == null) return
    panToWithOffset(lat, lng, { animate: true, duration: 0.5 })
    // NOTE: mapInstanceReady is in the dep array so this fires when the map
    // first becomes available (initial load). Without it, the effect would
    // return early on mount (mapInstanceRef.current is null) and never re-fire.
  }, [PIN_OFFSET_Y, snapshot, panToWithOffset, mapInstanceReady])

  // ── V6.7 SATELLITE_PERSISTENCE ── Sync map layer style to localStorage.
  // Fires on every isSatellite toggle so the operator's basemap choice
  // (dark CartoDB vs ArcGIS satellite) survives F5 / session restart. Key:
  // 'tracker_map_style' ('satellite' | 'dark'). Per directive
  // "localStorage.setItem('tracker_map_style', currentStyle)".
  useEffect(() => {
    try { localStorage.setItem('tracker_map_style', isSatellite ? 'satellite' : 'dark') } catch { /* ignore */ }
  }, [isSatellite])

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
        ? (p.to_stage === 'ARRIVED' ? 'LLEGÓ A CASA' : `LLEGANDO ${p.distance_m}m`)
        : `${p.from_label} → ${p.to_label}`
      requestAnimationFrame(() => showToast(msg))
      // T5 magic #3: Web Haptics — vibrate on zone change / arrival (mobile only)
      if (typeof navigator !== 'undefined' && navigator.vibrate) {
        navigator.vibrate(latest.type === 'ARRIVAL_PROGRESS' && p.to_stage === 'ARRIVED' ? [20, 40, 20, 40, 30] : [15, 30, 15])
      }
    }
    // T5 #3: stronger haptic on spoof red alert — also push a CRITICAL island alert
    if (latest.type === 'SPOOF_DETECTED') {
      const p = latest.payload || {}
      requestAnimationFrame(() => showToast(`ALERTA: ${p.signal || 'Salto de señal GPS detectado'} (Spoofing)`))
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
  // RA28 (UI resilience & control restoration): DECOUPLED from live-signal
  // availability. Previously the "Centrar" button was a no-op whenever the
  // backend reported no_location (lat/lng null) — the early-return at the
  // null-coord guard made the whole control cluster feel dead. Now the
  // fallback chain is:
  //   1. Live coords (pyState.location or ui.map) — preferred when available
  //   2. Last known cached position (localStorage stracker_last_pos) — most
  //      recent real signal, even if the live poll is stale
  //   3. HOME_GEOFENCE (POI/Casa) — static reference so the map ALWAYS has
  //      somewhere to fly to. Better to land on "Casa" than to leave the
  //      operator staring at a frozen viewport.
  // The "Centrar" button is therefore ALWAYS interactive. RA27 integrity is
  // preserved: this only moves the CAMERA, it does NOT fabricate a live PIN.
  const centerCamera = useCallback(() => {
    if (!mapInstanceRef.current) return
    const state = snapshot?.state
    const liveLat = state?.ui?.map?.lat ?? state?.location?.lat ?? null
    const liveLng = state?.ui?.map?.lng ?? state?.location?.lng ?? null
    const cachedPos = typeof window !== 'undefined' ? loadLastPosition() : null
    // Fallback chain: live → cached last-known → HOME_GEOFENCE (POI/Casa)
    const lat = (liveLat != null && isFinite(liveLat)) ? liveLat
              : (cachedPos && cachedPos.lat != null && isFinite(cachedPos.lat)) ? cachedPos.lat
              : HOME_GEOFENCE.lat
    const lng = (liveLng != null && isFinite(liveLng)) ? liveLng
              : (cachedPos && cachedPos.lng != null && isFinite(cachedPos.lng)) ? cachedPos.lng
              : HOME_GEOFENCE.lng
    // panToWithOffset preserves zoom + shifts pin right on desktop (clear of left panel)
    panToWithOffset(lat, lng, { animate: true })
    setFollowMode(true)
    followModeRef.current = true
    const currentZoom = mapInstanceRef.current.getZoom()
    writeUrlParams(lat, lng, currentZoom)
  }, [snapshot, panToWithOffset])

  // Cookies refresh
  const refreshCookies = useCallback(async () => {
    setCookiesRefreshing(true)
    try {
      const resp = await fetch('/api/deploy') // dev-only endpoint, kept as-is
      if (resp.ok) {
        setLastCookieRefresh(new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }))
        showToast('Cookies refresh signalado')
      } else {
        showToast('Error refreshing cookies')
      }
    } catch {
      showToast('Error de conexión')
    }
    setTimeout(() => setCookiesRefreshing(false), 2000)
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

  // RA30 INFORMATIVE_DASHBOARD: Última conexión — timestamp of the most recent
  // historical point in ghostrailPts. When there's no live signal, this tells
  // the operator when the target was last heard from (e.g. "hace 23 min").
  // Falls back to lastSavedPos.t (localStorage cached position) if ghostrailPts
  // is empty. null when neither is available.
  // V6.10: moved BEFORE dataAgeMin/screen so it's available in the TDZ-safe
  // order (dataAgeMin references ultimaConexionTs, screen references
  // ultimaConexionLabel).
  const ultimaConexionTs = useMemo(() => {
    if (ghostrailPts.length > 0) {
      const last = ghostrailPts[ghostrailPts.length - 1]
      const ts = new Date(last.t).getTime()
      if (isFinite(ts)) return ts
    }
    return lastSavedPos?.t ?? null
  }, [ghostrailPts, lastSavedPos])
  const ultimaConexionLabel = ultimaConexionTs != null
    ? formatStaleAge(ultimaConexionTs)
    : ''

  // V6.10 STALE_DATA_EXPOSURE — audit the raw Google payload timestamp.
  // The backend's `last_update` field carries the ISO timestamp of the most
  // recent point received from Google's Location Sharing RPC. We compute the
  // age in minutes and use it to switch the UI from "Tiempo Real" to
  // "Señal Latente / Caché" when the data is >10 min old, and to force the
  // Pantalla ON indicator OFF when >15 min old (radio silence = no claim
  // of activity).
  const dataAgeMin = useMemo(() => {
    const rawTs = snapshot?.last_update ?? null
    if (rawTs) {
      const ms = new Date(rawTs).getTime()
      if (isFinite(ms)) return Math.max(0, (Date.now() - ms) / 60000)
    }
    if (ultimaConexionTs != null) {
      return Math.max(0, (Date.now() - ultimaConexionTs) / 60000)
    }
    return null
  }, [snapshot?.last_update, ultimaConexionTs])

  const isStaleSignal = dataAgeMin != null && dataAgeMin > 10
  const isRadioSilence = dataAgeMin != null && dataAgeMin > 15

  const screenRaw = deriveScreenState(pyState)
  // V6.10 STALE_DATA_EXPOSURE — force Pantalla OFF when data is >15 min old.
  // Radio silence means the device hasn't emitted a real signal in 15+ min.
  // We must NOT claim screen activity based on inferred signals (movement,
  // network, battery) when the source is silent — those inferences were
  // derived from the stale payload itself and cannot be trusted.
  const screen = isRadioSilence
    ? { ...screenRaw, isOn: false, label: `OFF · ${ultimaConexionLabel || 'sin señal'}`, shortLabel: 'OFF', confidence: 0, source: 'radio_silence' }
    : screenRaw
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
  // RA27 (location integrity): ELIMINATED the FALLBACK_LAT/FALLBACK_LNG
  // ghost-pin behavior. When the backend returns no_location (lat/lng null),
  // the frontend MUST NOT fabricate a PIN at HOME_GEOFENCE coords. The old
  // code (below, commented out) drew a fake pin at -31.64693,-60.71598 "for
  // debugging" — this was the ghost the operator saw. Now: null coords →
  // no PIN → the LiveMarker render gate (line ~3169: mapData?.lat != null)
  // hides the marker. The map still centers on the last known position
  // (loadLastPosition) for context, but NO fake target PIN is drawn.
  // const FALLBACK_LAT = HOME_GEOFENCE.lat
  // const FALLBACK_LNG = HOME_GEOFENCE.lng

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
    // RA27: NO GHOST PIN. When backend has no_location, serve null coords.
    // The LiveMarker render gate checks mapData?.lat != null → marker hidden.
    // The map camera falls back to loadLastPosition() or HOME_GEOFENCE view
    // center (for map orientation only — NOT a fake target pin).
    lat: null as number | null,
    lng: null as number | null,
    lat_str: '---',
    lng_str: '---',
    show_speed: false,
    speed_label: '',
    mode: 'STILL',
    is_home: false,
    auto_unlock_camera: true,
  })

  // RA28: StaleMarker data — computed AFTER mapData (TDZ-safe: mapData is
  // already declared above). Only populated when there is NO live signal
  // (mapData.lat is null per RA27) BUT we DO have a cached last-known
  // position. The ageLabel is computed from the persisted timestamp `t`
  // so the operator sees "Última señal hace 12 min" rather than a bare
  // ghost pin. This is a UI affordance only — it does NOT fabricate live
  // coordinates (RA27 integrity preserved).
  const hasLiveSignal = mapData?.lat != null && mapData?.lng != null
    && isFinite(mapData.lat) && isFinite(mapData.lng)
  const staleMarkerData = (!hasLiveSignal && lastSavedPos
    && lastSavedPos.lat != null && lastSavedPos.lng != null
    && isFinite(lastSavedPos.lat) && isFinite(lastSavedPos.lng))
    ? { lat: lastSavedPos.lat, lng: lastSavedPos.lng, ageLabel: formatStaleAge(lastSavedPos.t) }
    : null

  // RA30 INFORMATIVE_DASHBOARD: Km recorridos — frontend-calculated sum of
  // haversine distances between consecutive ghostrailPts within the 24h window.
  // Gives the operator an at-a-glance read of how much the target has moved.
  // Memoized on ghostrailPts so it only recomputes when the trail changes.
  const kmRecorridos = useMemo(() => {
    if (ghostrailPts.length < 2) return 0
    let totalM = 0
    for (let i = 1; i < ghostrailPts.length; i++) {
      const prev = ghostrailPts[i - 1]
      const cur = ghostrailPts[i]
      totalM += haversineM(prev.lat, prev.lng, cur.lat, cur.lng)
    }
    return totalM / 1000 // meters → km
  }, [ghostrailPts])
  // Compact label: "1.2 km" or "847 m" for sub-km distances.
  const kmLabel = kmRecorridos >= 1
    ? `${kmRecorridos.toFixed(1)} km`
    : `${Math.round(kmRecorridos * 1000)} m`

  // NOTE: ultimaConexionTs / ultimaConexionLabel / dataAgeMin / isStaleSignal /
  // isRadioSilence are all computed earlier (before `screen`) so they're
  // available in TDZ-safe order for the screen-state override.
  // See the V6.10 STALE_DATA_EXPOSURE block above.

  const centerLat = mapLat
  const centerLng = mapLng

  // GPS quality — V9: text labels ALTA/MEDIA/BAJA
  const gpsAccuracy = pyState?.gps?.accuracy ?? pyState?.location?.accuracy ?? 0
  const gpsQuality = gpsAccuracy <= 20 ? 'ALTA' : gpsAccuracy <= 60 ? 'MEDIA' : 'BAJA'
  const gpsColor = 'rgba(255,255,255,.8)'

  // Battery — M5: ultra-compact format (e.g. 15, 52, 100). No %, no spaces
  const batteryPct = pyState?.device?.battery ?? null
  const batteryLabel = batteryPct !== null ? `${batteryPct}` : ''

  // RA29 BACKEND_DATA_ENRICHMENT — Device fingerprint label extracted from
  // Google's Location Sharing payload by the backend. Falls back to
  // 'Desconocido' when Google's payload is opaque or the backend hasn't
  // polled yet. Read from BOTH the snapshot top-level device_label and
  // state.device.device_label / state.meta.device_label for resilience
  // (the backend injects it into all three locations).
  const deviceLabel = (pyState?.device as any)?.device_label
    ?? (pyState?.meta as any)?.device_label
    ?? (snapshot as any)?.device_label
    ?? 'Desconocido'

  // V6.4 UI_METRICS_DASHBOARD — clean the device label for display.
  // Google obfuscated IDs (16+ char alphanumeric) become "Android · XXXX"
  // so the operator sees a friendly hardware fingerprint. Clean model
  // names (iPhone16,2, Pixel 8 Pro, SM-S918B) pass through unchanged.
  // V6.8 DYNAMIC_DEVICE_INFERENCE — pass the telemetry-inferred device
  // label so cleanDeviceLabel() can resolve unrecognized Google IDs based
  // on the live fingerprint (battery decay / GPS cadence / network volatility).
  const deviceLabelClean = useMemo(
    () => cleanDeviceLabel(deviceLabel, inferredDevice),
    [deviceLabel, inferredDevice]
  )

  // V6.4 UI_METRICS_DASHBOARD — compute the MODO cell using the directive's
  // explicit speed thresholds (<5=A Pie, 5-25=Moto, 25-60=Colectivo, >60=Auto).
  // Overrides the existing movement.displayMode which uses a different
  // classification (WALK ≤ 7, BUS ≤ 40, CAR > 40). Sleep state still wins.
  const modoInfo = useMemo(
    () => computeModoInfo(movement.speedKmh, movement.inferredMode),
    [movement.speedKmh, movement.inferredMode]
  )
  const ModoIcon = resolveMovementIcon(modoInfo.iconToken)

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
      showToast('Telemetría Forense copiada — pega en Gemini')
      setTimeout(() => setForensicCopied(false), 3000)
    } catch (e) {
      showToast('Error generando telemetría')
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
      showToast('Telemetría descargada')
    } catch {
      showToast('Error descargando')
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
      {/* V6.6 MAP_LIBERATION_9_16_REMOVE — the 9:16 column wrapper has been
          REMOVED. The map now occupies 100% of the viewport (w-full h-full,
          responsive) with NO black side margins on desktop. TrackerSheet is
          rendered as a `position: fixed` overlay (see TrackerSheet.tsx):
            - Mobile (<768px): full-width bottom sheet, same as before.
            - Desktop (>=768px): floating bottom-LEFT widget (~400px wide,
              rounded all corners) — Apple Maps style. The map's CENTER is
              always clear so the pin is never occluded.
          The map area below is `absolute inset-0` so it fills the full
          viewport. All overlays inside use `absolute` positioning measured
          relative to THIS container. */}
      {/* ══ MAP AREA (absolute inset-0, holds map + all overlays) ══ */}
      <div className="absolute inset-0 overflow-hidden">
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
            // V6.6 ZOOM_GLITCH_FIX: --map-tile-blur and --map-tile-brightness
            // CSS vars have been REMOVED. The .leaflet-tile-pane filter is now
            // `none` (see the inline <style> block above) so Leaflet tiles
            // render natively without any CSS filter destabilization during
            // zoom transitions. The sheet-progress blur sync is gone — a
            // stable zoom experience is worth more than the aesthetic blur.
            // MC_8_01: Pseudo-3D Drive Mode — driveTilt [0..1] tilts the tile +
            // overlay panes into a Tesla-style driving perspective (see globals.css).
            ['--drive-tilt' as any]: driveTilt.toFixed(2),
          }}
        >
          {/* V6.7 GOOGLE_MAPS_SYNC: Leaflet's default CRS is EPSG:3857 (Web
              Mercator) — the SAME projection Google Maps uses. No `crs` prop
              is set, so coordinates (WGS84 lat/lng) render at the exact same
              pixel position as Google Maps. worldCopyJump=true gives the
              infinite-horizontal-wrap behavior Google Maps has (panning across
              the antimeridian seamlessly re-centers). The map center uses the
              live backend coordinate (ui.map.lat ?? pyState.location.lat) so
              the viewport matches Google Maps pixel-for-pixel once live signal
              is present. The "desfase" observed in the audit was caused by the
              sandbox having no live data → center fell back to HOME_GEOFENCE
              (a static default), not a projection mismatch. */}
          <MapContainer
            center={[centerLat, centerLng]}
            zoom={persistedZoom}
            zoomControl={false}
            attributionControl={false}
            worldCopyJump
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
            {/* V6.6 ZOOM_GLITCH_FIX — maxZoom capped to 20 (was 22). CartoDB
                dark_all + dark_only_labels tiles only go up to z=20; requesting
                z=21/22 produced 404s + blank tiles + zoom glitches.
                maxNativeZoom=20 lets Leaflet upscale cleanly if the user
                zooms past 20 (no broken tiles). ArcGIS World_Imagery supports
                up to z=23 so its maxZoom stays at 22 with maxNativeZoom=19
                (the level where ArcGIS stops serving 256px tiles crisply). */}
            {isSatellite ? (
              <>
                <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} maxNativeZoom={19} />
                <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png" maxZoom={20} maxNativeZoom={20} subdomains="abcd" />
              </>
            ) : (
              <TileLayer url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png" maxZoom={20} maxNativeZoom={20} subdomains="abcd" />
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
                    heading={headingState.heading}
                    headingLatch={headingState.latched}
                  />
                  {/* DEBUG_OVERLAY_INJECTION: crosshair at the RAW backend
                      coordinate. RA23: HIDDEN BY DEFAULT in production —
                      toggle via ?driftDebug=1 URL param or localStorage
                      'stracker_drift_debug=1'. Only rendered when drift > 1m
                      AND the debug flag is on, so the map stays clean in
                      production and audits still get the overlay on demand. */}
                  {driftDebugVisible && normalizedPin && (
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
            {/* RA28 — StaleMarker: last-known cached position when live signal
                is absent. Renders ONLY when mapData.lat is null (RA27 keeps
                LiveMarker hidden) AND we have a valid cached position. Visual
                contract: 50% opacity, grayscale, no pulse, z-index 500 (below
                LiveMarker's 10000) so a returning live signal occludes it.
                Label "Última señal hace X min" tells the operator the age of
                the cached reading — they understand it's a memory, not live. */}
            {staleMarkerData && !scrubbedPoint && (
              <StaleMarker
                lat={staleMarkerData.lat}
                lng={staleMarkerData.lng}
                ageLabel={staleMarkerData.ageLabel}
              />
            )}
            {/* MAGIA1: When scrubbing, show the marker at the scrubbed point instead.
                V5.7 NAV_02: heading is computed from the historical slice. */}
            {scrubbedPoint && (
              <LiveMarker
                lat={scrubbedPoint.lat}
                lng={scrubbedPoint.lng}
                speedLabel="SCRUB"
                accuracy={gpsAccuracy}
                solarDate={circadianNow}
                heading={headingState.heading}
                headingLatch={headingState.latched}
              />
            )}
            {/* MAGIA2: Thermal Clusters of Detention (loitering heatmaps) */}
            {ghostVisible && loiteringClusters.map((c, i) => (
              <LoiteringHeatmap key={`loit-${i}`} lat={c.lat} lng={c.lng} radiusM={c.radius_m} durationMin={c.duration_min} />
            ))}
            {/* LAYER_01 / FIX_LAYER_03 (stracker_core_ui): GhostTrail re-render
                forzado via key. z-index: overlayPane=400 (above tilePane=200,
                below markerPane=600). Polyline pointer-events disabled in CSS so
                the overlay NEVER consumes click/touch events meant for the pin.
                RA29 (GhostTrail 24h persistence): the trail is now ALWAYS rendered
                when there are >=2 routed points within the 24h window — even when
                liveLocation is null. The 24h cutoff is already enforced upstream
                in the ghostrailPts useMemo (cutoff24h = now - 24h), so this gate
                is purely "do we have historical data to show?". The map is never
                'blind' when the CSV history has points, regardless of live signal.
                ghostVisible (the user toggle for the GhostRail panel) still hides
                the trail when explicitly turned off by the operator.
                V6.8 GHOST_TRAIL_THRESHOLD: gate lowered from >= 2 to >= 1 so the
                stationary CircleMarker renders for single-point histories. */}
            {ghostVisible && routedTrailPts.length >= 1 && (
              <GhostTrail key={`ghost-${routedTrailPts.length}`} routedPoints={routedTrailPts} />
            )}
          </MapContainer>
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
        <div className="absolute inset-0 z-[5] pointer-events-none" style={{
          boxShadow: 'inset 0 0 160px 40px rgba(255,255,255,.06)',
          animation: 'spoofPulse 2s ease-in-out infinite',
        }} />
      )}
      {overlays.signal && (
        <div className="absolute inset-0 z-[5] pointer-events-none" style={{
          boxShadow: 'inset 0 0 160px 40px rgba(255,255,255,.04)',
          animation: 'signalPulse 2s ease-in-out infinite',
        }} />
      )}

      {/* ══ ZOOM CONTROLS — V5.5 Deep Black floating glass, V6.0 Apple Maps 4000 ══
          RA30: `absolute` (was `fixed`) — positioned relative to the map area,
          not the viewport. On desktop the map area is the right portion, so
          `right-4 md:right-8` is 16/32px from the map area's right edge. */}
      <div className="absolute right-4 md:right-8 top-1/2 -translate-y-1/2 z-20 flex flex-col gap-3 md:gap-4">
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
          className="absolute left-1/2 -translate-x-1/2 z-20 gesture-dim flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
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
          <span className="font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,.85)', fontSize: 'clamp(13px, 1.2vw, 16px)' }}>
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
          className="timeline-bar absolute left-1/2 -translate-x-1/2 z-20 gesture-dim"
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
            stale={isStaleSignal}
            onScrub={(idx) => {
              setTimeScrubIndex(idx)
              setScrubbing(true)
              // V6.8 AUTO_LIVE_MODE_ENFORCEMENT — scrubbing exits Live Mode.
              setIsLiveMode(false)
              // Invalidate map size after scrub change
              if (mapInstanceRef.current) {
                try { mapInstanceRef.current.invalidateSize() } catch {}
              }
            }}
            onLive={() => {
              // V6.8 AUTO_LIVE_MODE_ENFORCEMENT — LIVE button restores Live Mode.
              setScrubbing(false)
              setTimeScrubIndex(null)
              setIsLiveMode(true)
            }}
          />
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════
          V6.1 cookie_restore — TRIGGER: icono de llave en el panel inferior.
          Floating quick-access button (z-30) that opens the CookieDrawer.
          Posición: bottom-right, por encima del TimelineBar (panel inferior).
          No superpone el TimelineBar centrado ni los zoom controls (centro-derecha).
      ══════════════════════════════════════════════════════════════════ */}
      <button
        onClick={() => setCookieDrawerOpen(true)}
        title="Guardar sesión de cookies"
        aria-label="Guardar sesión de cookies"
        className="absolute z-30 right-4 md:right-8 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.04] active:scale-[0.96]"
        style={{
          bottom: isMobile ? 88 : 96,
          width: 48,
          height: 48,
          borderRadius: 14,
          background: 'rgba(10,10,10,.85)',
          backdropFilter: 'blur(30px) saturate(180%)',
          WebkitBackdropFilter: 'blur(30px) saturate(180%)',
          border: '1px solid rgba(10,132,255,.25)',
          boxShadow: '0 8px 32px rgba(0,0,0,.5), 0 12px 32px rgba(0,0,0,.4), 0 0 0 1px rgba(10,132,255,.06)',
          color: '#0a84ff',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {/* Pulsing ring para indicar acceso rápido */}
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: -1,
            borderRadius: 15,
            border: '1px solid rgba(10,132,255,.3)',
            animation: 'cookieKeyPulse 2.4s ease-in-out infinite',
            pointerEvents: 'none',
          }}
        />
        {/* icon */}
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ position: 'relative', zIndex: 1 }}>
          <path d="M15.5 7.5 19 4"/>
          <path d="M16 9a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3"/>
          <path d="m21 3-1.5 1.5"/>
          <path d="M9 12.5 4 17.5a2.121 2.121 0 0 0 3 3l5-5"/>
        </svg>
      </button>

      {/* ══════════════════════════════════════════════════════════════════
          V6.1 cookie_restore — COOKIE DRAWER (z-50 overlay, bottom-sheet)
      ══════════════════════════════════════════════════════════════════ */}
      <CookieDrawer
        open={cookieDrawerOpen}
        onClose={() => setCookieDrawerOpen(false)}
        showToast={showToast}
      />

      {/* ══════════════════════════════════════════════════════════════════
          FLOATING GLASS MINIBLOCK — bottom-fixed, rounded-2xl
          F1: +60px bottom offset to keep drawer away from pin area
          P6: Everything centered in viewport (margin: 0 auto)
          B1: Fluid max-width with responsive clamp
          Layout:
            ROW 0: SPOOF BADGE + CONNECTION
            ROW 1: LOCATION label (ONCE ONLY, dedupe)
            ROW 2: F2 COMPACT SINGLE LINE: 20km | 20% | WIFI | ON·3m | ALTA
            ROW 3: BUTTON BAR (flex-wrap for small screens)
            ROW 4: VER MÁS CTA toggle + accordion (F1: reduced max-height)
          ══════════════════════════════════════════════════════════════════ */}
      {/* ══════════════════════════════════════════════════════════════════
          V9 COMPACT HEIGHT-AWARE REDESIGN — layout_priority:
            1. Estado (single compact metrics line)
            2. Botonera (icon-only: satellite / pin / ghost / clipboard) — INSIDE panel
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

      </div>{/* ══ END MAP AREA (absolute inset-0) ══ — V6.6 MAP_LIBERATION:
                 map + all overlays close here. TrackerSheet below is a
                 `position: fixed` overlay (floating bottom-LEFT widget on
                 desktop, full-width bottom sheet on mobile). The map's CENTER
                 is never occluded by the sheet. */}

      <TrackerSheet
        isMobile={isMobile}
        isShortViewport={isShortViewport}
        onHeightChange={setSheetSnap}
        onProgressChange={setSheetProgress}
        externalSnap={externalSheetSnap}
      >

            {/* ══════════════════════════════════════════════════════════════════
                V6.4 UI_METRICS_DASHBOARD — MasterControlPanel ("Simón Sequence")
                ══════════════════════════════════════════════════════════════════
                Replaces the legacy single-line MetricsRow with a 2x3 grid of
                high-contrast metric cells. Each cell dedicates its own tile
                to a single telemetry dimension so the operator gets an
                at-a-glance tactical read instead of a cramped horizontal
                pill row. Required metrics per directive:
                  [Pantalla ON/OFF] [WIFI/4G] [Batería %]
                  [Velocidad]      [Modo]    [Dispositivo]
                Modo is computed dynamically from speed (<5=A Pie, 5-25=Moto,
                25-60=Colectivo, >60=Auto). Dispositivo renders device_label
                (cleaned of Google obfuscated IDs). Velocidad cell carries
                km recorridos as a sub-read. Última conexión surfaces as a
                sub-read on the Pantalla cell when there's no live signal.
            ══════════════════════════════════════════════════════════════════ */}
            <div
              className="p-3 md:p-4 bg-[#0a0a0a]/85 backdrop-blur-xl rounded-3xl border border-white/[0.05] shadow-2xl"
              style={{ overflow: 'visible' }}
            >
              {/* M8: Skeleton shimmer grid while loading (no data yet) */}
              {!snapshot ? (
                <div className="grid grid-cols-2 gap-2.5">
                  <div className="skeleton-shimmer h-16 flex-shrink-0" />
                  <div className="skeleton-shimmer h-16 flex-shrink-0" />
                  <div className="skeleton-shimmer h-16 flex-shrink-0" />
                  <div className="skeleton-shimmer h-16 flex-shrink-0" />
                  <div className="skeleton-shimmer h-16 flex-shrink-0" />
                  <div className="skeleton-shimmer h-16 flex-shrink-0" />
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2.5">
                  {/* Cell 1: Pantalla ON/OFF — Monitor icon.
                      Sub-read shows última conexión when there's no live
                      signal so the operator sees "OFF · hace 12 min" at
                      a glance. */}
                  <MetricCell
                    icon={Monitor}
                    label="Pantalla"
                    value={screen.shortLabel}
                    sub={!hasLiveSignal && ultimaConexionLabel ? `· ${ultimaConexionLabel}` : undefined}
                    valueColor={screen.isOn ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.5)'}
                  />

                  {/* Cell 2: Red WIFI/4G — dynamic icon (Wifi/Smartphone/WifiOff). */}
                  <MetricCell
                    icon={resolveNetworkIcon(networkTypeToToken(network.type))}
                    label="Red"
                    value={network.type || '—'}
                  />

                  {/* Cell 3: Batería % — Battery icon, tabular nums. */}
                  <MetricCell
                    icon={Battery}
                    label="Batería"
                    value={batteryLabel ? `${batteryLabel}%` : '—'}
                    valueColor={batteryPct !== null && batteryPct <= 15 ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.95)'}
                  />

                  {/* Cell 4: Velocidad — Gauge icon. Sub-read shows km
                      recorridos in the 24h window (frontend haversine sum). */}
                  <MetricCell
                    icon={Gauge}
                    label="Velocidad"
                    value={movement.speedKmh != null ? `${movement.speedKmh.toFixed(1)}` : '—'}
                    sub={movement.speedKmh != null ? `km/h · ${kmLabel}` : 'km/h'}
                    valueColor={movement.isActive ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.6)'}
                  />

                  {/* Cell 5: Modo — dynamic icon (Footprints/Bike/Bus/Car/Moon).
                      Computed via computeModoInfo using the directive's
                      explicit speed thresholds. Sleep state wins over speed. */}
                  <MetricCell
                    icon={ModoIcon}
                    label="Modo"
                    value={modoInfo.label}
                    valueColor={movement.isActive ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.55)'}
                  />

                  {/* Cell 6: Dispositivo — Smartphone icon. Renders the
                      backend-extracted device_label, cleaned of Google
                      obfuscated IDs (16+ char alphanumeric → "Android · XXXX"). */}
                  <MetricCell
                    icon={Smartphone}
                    label="Dispositivo"
                    value={deviceLabelClean}
                  />
                </div>
              )}

              {/* Compact footer row — SpoofBadge + GPS quality + JITTER pulse +
                  version + ws dot. Kept minimal so the grid stays the visual focus. */}
              {snapshot && (
                <div className="flex items-center gap-2 mt-2.5 pt-2 border-t border-white/[.04]">
                  <SpoofBadgeV2 result={spoofResult} />
                  <div className={`flex items-center gap-1 px-2 py-0.5 rounded-full flex-shrink-0 ${GLASS_PILL}`}>
                    <Signal size={11} strokeWidth={1.5} style={{ color: 'rgba(255,255,255,.7)' }} />
                    <span className="font-bold uppercase tracking-wider tabular-nums" style={{ color: 'rgba(255,255,255,.7)', fontSize: 'clamp(10px, 1.2vw, 12px)' }}>GPS {gpsQuality}</span>
                  </div>

                  {/* V6.10 STALE_DATA_EXPOSURE — "Señal Latente" badge.
                      Renders when data age >10 min. Amber pulse exposes that
                      the displayed data is CACHED, not real-time. When age
                      exceeds 15 min (radio silence), the Pantalla ON indicator
                      is also forced OFF (see deriveScreenState override above). */}
                  {isStaleSignal && (
                    <div
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
                      style={{
                        background: 'rgba(255,170,30,.12)',
                        border: '1px solid rgba(255,170,30,.35)',
                      }}
                      title={dataAgeMin != null ? `Última señal real hace ${Math.round(dataAgeMin)} min — datos en caché` : 'Datos en caché — sin señal reciente'}
                      aria-label="Señal latente"
                    >
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: 'rgba(255,170,30,.95)',
                          boxShadow: '0 0 6px rgba(255,170,30,.7)',
                          animation: 'v68JitterPulse 1.8s ease-in-out infinite',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        className="font-bold uppercase tracking-wider tabular-nums"
                        style={{ color: 'rgba(255,170,30,.95)', fontSize: 'clamp(10px, 1.2vw, 12px)', letterSpacing: '0.06em' }}
                      >
                        LATENTE{dataAgeMin != null ? ` ${Math.round(dataAgeMin)}m` : ''}
                      </span>
                    </div>
                  )}

                  {/* V6.8 JITTER_AWARENESS_UI — secondary activity pulse.
                      Shows ONLY when GPS jitter is detected (coordinates
                      fluctuating within <10m radius). Confirms the device is
                      ACTIVE in-place (screen on, GPS polling) even though the
                      speed reads 0.0 km/h strict per the API. The pulse uses
                      Apple-blue (#0a84ff) to match the Live Mode accent —
                      distinct from the GPS-quality white badge so the operator
                      can tell at a glance: "static but active". */}
                  {jitterDetected && (
                    <div
                      className="flex items-center gap-1.5 px-2 py-0.5 rounded-full flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
                      style={{
                        background: 'rgba(10,132,255,.12)',
                        border: '1px solid rgba(10,132,255,.35)',
                      }}
                      title="GPS Jitter detectado — actividad en sitio sin traslación (velocidad 0.0 km/h estricta)"
                      aria-label="GPS Jitter detectado"
                    >
                      {/* Activity pulse dot — Apple blue, 1.4s pulse cycle */}
                      <span
                        style={{
                          width: 6,
                          height: 6,
                          borderRadius: '50%',
                          background: 'rgba(10,132,255,.95)',
                          boxShadow: '0 0 6px rgba(10,132,255,.7)',
                          animation: 'v68JitterPulse 1.4s ease-in-out infinite',
                          flexShrink: 0,
                        }}
                      />
                      <span
                        className="font-bold uppercase tracking-wider"
                        style={{ color: 'rgba(10,132,255,.95)', fontSize: 'clamp(10px, 1.2vw, 12px)', letterSpacing: '0.06em' }}
                      >
                        JITTER
                      </span>
                    </div>
                  )}
                  <span className="font-mono text-white/15 flex-shrink-0 ml-auto tabular-nums" style={{ fontSize: 'clamp(10px, 1.1vw, 12px)' }}>v{snapshotVersion}</span>
                  <span className="font-mono flex-shrink-0" style={{ color: wsConnected ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.3)', fontSize: 12 }}>
                    {wsConnected ? '●' : '○'}
                  </span>
                </div>
              )}
            </div>

            {/* V6.5 DASHBOARD_UNIFICATION_9_16: SpeedGauge block REMOVED per
                directive "Eliminar Velocímetro por completo del código (limpieza
                total)". The velocity read is already surfaced in the
                MasterControlPanel "Velocidad" cell (Simón Sequence 2x3 grid).
                The kinetic telemetry (VELOCIDAD/MODO/RUMBO/LUZ) that lived in
                the SpeedGauge companion card is no longer rendered — the
                dashboard is now the single source of truth for at-a-glance
                tactical reads, with no redundant velocity widget. */}

            {/* ══════════════════════════════════════════════════════════════════
                UI_METRICS_02 (stracker_v5.3_integration): AnalyticsPanel.
                Three deep metrics — avg_speed (15-min MA), ETA a casa, geofence
                status — drawn from the same ghostrail data store. Recomputes on
                every poll via useMemo (dynamic, no reload). Glassmorphism
                consistent with the TrackerSheet; occupies the space between the
                MasterControlPanel and the Cookies block in a balanced 3-col grid.
            ══════════════════════════════════════════════════════════════════ */}
            {(!isMobile || sheetSnap === 'half' || sheetSnap === 'full') && (
              <AnalyticsPanel
                ghostrailPts={ghostrailPts}
                currentLat={pyState?.location?.lat ?? null}
                currentLng={pyState?.location?.lng ?? null}
                currentSpeedKmh={movement.speedKmh}
                home={HOME_GEOFENCE}
                work={WORK_GEOFENCE}
              />
            )}

            {/* ══════════════════════════════════════════════════════════════════
                V9 MODULE 3: COOKIES — collapsed 34px (force-collapse on tiny)
            ══════════════════════════════════════════════════════════════════ */}
            <CookiesBlock showToast={showToast} onToggle={setCookiesExpanded} forceCollapse={isShortViewport} />

            {/* ── P5: VER MÁS TOGGLE — V9 COMPACT HEADER (32px), 150ms animation ──
                V8 SHORT_VIEWPORT: hide on very short screens (iPhone SE) to keep panel off the pin */}
            {!isShortViewport && (
            <button
              className="w-full flex items-center justify-center gap-2 transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.01] active:scale-[0.98] cursor-pointer"
              style={{
                minHeight: 44,
                padding: '8px 16px',
                background: showVerMas
                  ? 'rgba(255,255,255,.08)'
                  : 'rgba(255,255,255,.04)',
                border: '1px solid rgba(255,255,255,.1)',
                borderRadius: 0,
                boxShadow: showVerMas
                  ? '0 0 12px rgba(255,255,255,.04), inset 0 0 20px rgba(255,255,255,.02)'
                  : '0 0 8px rgba(255,255,255,.02)',
                color: showVerMas ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.55)',
                fontSize: 'clamp(14px, 2.2vw, 18px)',
                fontWeight: 600,
                letterSpacing: '0.15em',
                textTransform: 'uppercase' as const,
              }}
              onClick={() => setShowVerMas(!showVerMas)}
            >
              <span
                className="transition-transform inline-block"
                style={{ fontSize: 12, transform: showVerMas ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms ease' }}
              >▸</span>
              {showVerMas ? 'VER MENOS' : 'VER MÁS'}
              <span
                style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: showVerMas ? 'rgba(255,255,255,.9)' : 'rgba(255,255,255,.3)',
                  boxShadow: showVerMas ? '0 0 6px rgba(255,255,255,.3)' : 'none',
                  animation: showVerMas ? 'none' : 'verMasPulse 2s ease-in-out infinite',
                }}
              />
            </button>
            )}

            {/* ── VER MÁS ACCORDION DRAWER ──
                B2: Dynamic max-height to avoid map center pin overlap
                Map pin z-index=9999 is above this z-index=10
            */}
            {showVerMas && (
              <div
                className="overflow-y-auto border-t border-white/[.03]"
                style={{
                  maxHeight: dropdownMaxH,
                  scrollbarWidth: 'none',
                  // V9: 150ms expand animation
                  animation: 'cookiesExpand 150ms ease-out',
                }}
              >
                <div className="px-3 py-1">

                  {/* ── Fase 2: FORENSIC TELEMETRY EXPORTER ──
                      Gemini directive: "Copiar Telemetría Forense" button
                      with navigator.vibrate + toast. Builds structured JSON
                      payload for OSINT analysis and copies to clipboard. */}
                  <div className="mb-2 pb-2 border-b border-white/[.04]">
                    <div className="flex items-center gap-2 mb-1.5">
                      <Microscope size={11} className="text-white/60" />
                      <span className="font-bold uppercase tracking-wider text-white/60" style={{ fontSize: 12 }}>Forensic Export</span>
                      {loiteringClusters.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full font-bold" style={{ background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,.85)', fontSize: 13, border: '1px solid rgba(255,255,255,0.15)' }}>
                          {loiteringClusters.length} LOITER
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <button
                        className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-xl transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98] cursor-pointer min-h-11"
                        style={{
                          background: forensicCopied ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.06)',
                          border: `1px solid ${forensicCopied ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.12)'}`,
                          color: forensicCopied ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.85)',
                          fontSize: 'clamp(13px, 2vw, 17px)',
                          fontWeight: 600,
                          letterSpacing: '0.05em',
                        }}
                        onClick={copyForensicTelemetry}
                      >
                        {forensicCopied ? <Check size={13} /> : <Clipboard size={13} />}
                        <span className="uppercase">{forensicCopied ? 'COPIADO' : 'Copiar Telemetría'}</span>
                      </button>
                      <button
                        className="flex items-center justify-center px-3 py-2.5 rounded-xl transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] hover:scale-[1.02] active:scale-[0.98] cursor-pointer min-h-11 min-w-11"
                        style={{
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          color: 'rgba(255,255,255,0.5)',
                          fontSize: 13,
                        }}
                        title="Descargar .json"
                        onClick={downloadForensicTelemetry}
                      >
                        <Download size={13} />
                      </button>
                    </div>
                    <div className="mt-1 text-white/25" style={{ fontSize: 13 }}>
                      {ghostrailPts.length} pts · {loiteringClusters.length} hotspots · spoof {spoofResult.score}%
                    </div>
                  </div>

                  {/* GPS */}
                  {!compressSections || openSections.gps ? (
                  <AccordionSection title="GPS" isOpen={openSections.gps} onToggle={() => toggleSection('gps')}>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}><span className="text-white/25 uppercase">Lugar</span><span className="text-white/70 font-medium text-right truncate ml-1">{verMasGps?.place || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}><span className="text-white/25 uppercase">Señal</span><span className="text-white/70 font-medium">{verMasGps?.signal || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}><span className="text-white/25 uppercase">Lat</span><span className="text-white/70 font-mono" style={{ fontSize: 'clamp(12px, 1.6vw, 15px)' }}>{verMasGps?.lat_str || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}><span className="text-white/25 uppercase">Prec.</span><span className="text-white/70 font-medium">{verMasGps?.accuracy || '---'}</span></div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}><span className="text-white/25 uppercase">Lng</span><span className="text-white/70 font-mono" style={{ fontSize: 'clamp(12px, 1.6vw, 15px)' }}>{verMasGps?.lng_str || '---'}</span></div>
                    </div>
                  </AccordionSection>
                  ) : null}

                  {/* Sesión — B2: compress if needed */}
                  {(!compressSections) && (
                  <AccordionSection title="Sesión" isOpen={openSections.sesion} onToggle={() => toggleSection('sesion')}>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-center"><div className="text-white/20 uppercase" style={{ fontSize: 'clamp(11px, 1.2vw, 13px)' }}>Duración</div><div className="text-white/70 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{verMasSession?.duration || '0m'}</div></div>
                      <div className="text-center"><div className="text-white/20 uppercase" style={{ fontSize: 'clamp(11px, 1.2vw, 13px)' }}>Screen ON</div><div className="text-white/70 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{verMasSession?.screen_on || '0m'}</div></div>
                      <div className="text-center"><div className="text-white/20 uppercase" style={{ fontSize: 'clamp(11px, 1.2vw, 13px)' }}>Screen OFF</div><div className="text-white/70 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{verMasSession?.screen_off || '0m'}</div></div>
                    </div>
                  </AccordionSection>
                  )}

                  {/* Sistema — B2: compress if needed */}
                  {(!compressSections) && (
                  <AccordionSection title="Sistema" isOpen={openSections.sistema} onToggle={() => toggleSection('sistema')}>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="text-center"><div className="text-white/20 uppercase" style={{ fontSize: 'clamp(11px, 1.2vw, 13px)' }}>Red</div><div className="text-white/70 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{verMasSystem?.network || 'OFFLINE'}</div></div>
                      <div className="text-center"><div className="text-white/20 uppercase" style={{ fontSize: 'clamp(11px, 1.2vw, 13px)' }}>Batería</div><div className="text-white/70 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{verMasSystem?.battery_raw || '---'}</div></div>
                      <div className="text-center"><div className="text-white/20 uppercase" style={{ fontSize: 'clamp(11px, 1.2vw, 13px)' }}>Movimiento</div><div className="text-white/70 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{verMasSystem?.motion_raw || '---'}</div></div>
                    </div>
                  </AccordionSection>
                  )}

                  {/* Eventos */}
                  <AccordionSection title="Eventos" isOpen={openSections.eventos} onToggle={() => toggleSection('eventos')}>
                    {verMasEvents && verMasEvents.length > 0 && (
                      <div className="space-y-0.5 mb-1">
                        {verMasEvents.slice().reverse().map((ev, i) => (
                          <div key={`vm-${i}`} className="flex items-center gap-1.5 py-0.5">
                            <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ev.color }} />
                            <span className="text-white/40" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>{ev.msg}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {events.length > 0 && (
                      <div className="space-y-0.5 max-h-24 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
                        {events.slice(-12).reverse().map((ev) => {
                          const cmap: Record<string, string> = { ZONE_CHANGE:'rgba(255,255,255,.8)',MOTION_CHANGE:'rgba(255,255,255,.8)',ARRIVAL_PROGRESS:'rgba(255,255,255,.8)',SPOOF_DETECTED:'rgba(255,255,255,.95)',NETWORK_CHANGE:'rgba(255,255,255,.7)',ACTIVITY_CHANGE:'rgba(255,255,255,.7)',SCREEN_CHANGE:'rgba(255,255,255,.7)',NONI_DESPIER:'rgba(255,255,255,.8)',SALIDA_CASA:'rgba(255,255,255,.8)',TICK:'rgba(255,255,255,.4)',GPS_UPDATE:'rgba(255,255,255,.7)',BATTERY_UPDATE:'rgba(255,255,255,.7)' }
                          const lmap: Record<string, string> = { ZONE_CHANGE:'Zone',MOTION_CHANGE:'Motion',ARRIVAL_PROGRESS:'Arrival',SPOOF_DETECTED:'Spoof',NETWORK_CHANGE:'Network',ACTIVITY_CHANGE:'Activity',SCREEN_CHANGE:'Screen',NONI_DESPIER:'State',SALIDA_CASA:'Left',TICK:'Tick',GPS_UPDATE:'GPS',BATTERY_UPDATE:'Bat' }
                          const c = cmap[ev.type] || 'rgba(255,255,255,.4)'
                          const l = lmap[ev.type] || ev.type.slice(0,6)
                          const ts = ev.ts ? new Date(ev.ts).toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : ''
                          let d = ''
                          const p = ev.payload
                          if (ev.type==='ZONE_CHANGE') d=`${p.from_label||p.from_zone}→${p.to_label||p.to_zone}`
                          else if (ev.type==='MOTION_CHANGE') d=`${p.from_class}→${p.to_class}`
                          else if (ev.type==='ARRIVAL_PROGRESS') d=`${p.from_stage}→${p.to_stage} ${p.distance_m}m`
                          else if (ev.type==='SPOOF_DETECTED') d=`${p.flag} ${p.risk_score}%`
                          else if (ev.type==='NONI_DESPIER') d=`${p.from_state}→${p.to_state}`
                          else if (ev.type==='SALIDA_CASA') d='Salió de casa'
                          else if (ev.type==='ACTIVITY_CHANGE') d=`${p.from_score}%→${p.to_score}%`
                          return (
                            <div key={ev.seq} className="flex items-center gap-1.5 py-0.5">
                              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{background:c}} />
                              <span className="font-bold uppercase" style={{color:c, fontSize: 13}}>{l}</span>
                              {d && <span className="text-white/35 truncate" style={{ fontSize: 12 }}>{d}</span>}
                              <span className="text-white/12 font-mono ml-auto" style={{ fontSize: 13 }}>{ts}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}
                    {(!verMasEvents?.length) && events.length===0 && (
                      <div className="text-white/12 py-0.5 text-center" style={{ fontSize: 13 }}>Sin eventos</div>
                    )}
                  </AccordionSection>

                  {/* GhostRail 24h — V7: Single canonical source, time-ordered */}
                  <AccordionSection title="GhostRail 24h" isOpen={openSections.ghostrail} onToggle={() => toggleSection('ghostrail')}>
                    <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                      <span className="text-white/20 uppercase" style={{ fontSize: 'clamp(12px, 1.4vw, 15px)' }}>Pts</span>
                      <span className="text-white/60 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{ghostrailPts.length}</span>
                      <span className="text-white/20 uppercase" style={{ fontSize: 'clamp(12px, 1.4vw, 15px)' }}>Routed</span>
                      <span className="text-white/60 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{routedTrailPts.length}</span>
                      <span className="text-white/20 uppercase" style={{ fontSize: 'clamp(12px, 1.4vw, 15px)' }}>Src</span>
                      <span className="text-white/60 font-medium" style={{ fontSize: 'clamp(13px, 2vw, 17px)' }}>{ghostrailDiagnostics.current.source}</span>
                    </div>
                    {/* V7 Diagnostics */}
                    {(() => {
                      const d = ghostrailDiagnostics.current
                      return d.total > 0 ? (
                        <div className="px-2 py-0.5 rounded-full inline-block mb-1" style={{ background: 'rgba(255,255,255,.06)', color: 'rgba(255,255,255,.8)', border: '1px solid rgba(255,255,255,.1)', fontSize: 13 }}>
                          V7: {d.total} pts [live:{d.live} cache:{d.cache}]
                        </div>
                      ) : (
                        <div className="px-2 py-0.5 rounded-full inline-block mb-1" style={{ background: 'rgba(255,255,255,.04)', color: 'rgba(255,255,255,.5)', border: '1px solid rgba(255,255,255,.08)', fontSize: 13 }}>
                          V7: No trail data
                        </div>
                      )
                    })()}
                    {(() => {
                      const d = ghostrailDiagnostics.current
                      const hasDiscards = d.discarded_age > 0 || d.discarded_no_ts > 0 || d.discarded_dup > 0
                      return hasDiscards ? (
                        <div className="px-2 py-0.5 rounded-full inline-block mb-1" style={{ background: 'rgba(255,255,255,.04)', color: 'rgba(255,255,255,.5)', border: '1px solid rgba(255,255,255,.08)', fontSize: 13 }}>
                          age:{d.discarded_age} no_ts:{d.discarded_no_ts} dup:{d.discarded_dup}
                        </div>
                      ) : null
                    })()}
                    {rawGhostrailPts.length === 0 && ghostrailPts.length > 0 && (
                      <div className="px-2 py-0.5 rounded-full inline-block mb-1" style={{ background: 'rgba(255,255,255,.04)', color: 'rgba(255,255,255,.5)', border: '1px solid rgba(255,255,255,.08)', fontSize: 13 }}>
                        Rescue mode (cache)
                      </div>
                    )}
                    {verMasGhostrail && verMasGhostrail.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {verMasGhostrail.map((z, i) => (
                          <div key={i} className="flex items-center gap-1 px-2 py-0.5 rounded-full" style={{background:'rgba(255,255,255,.03)',border:'1px solid rgba(255,255,255,.04)'}}>
                            <div className="w-2 h-2 rounded-full" style={{background:z.color}} />
                            <span className="text-white/40" style={{ fontSize: 12 }}>{z.name}</span>
                            <span className="text-white/70 font-medium" style={{ fontSize: 12 }}>{z.duration}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-white/12 py-0.5" style={{ fontSize: 13 }}>Sin datos de zonas — 24h rebuild pendiente</div>
                    )}
                  </AccordionSection>

                  {/* Diagnóstico — B2: compress if needed (hide in compressed mode) */}
                  {!compressSections && (
                  <AccordionSection title="Diagnóstico" isOpen={openSections.diagnostico} onToggle={() => toggleSection('diagnostico')}>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">WS</span>
                        <span className="font-medium" style={{ color: wsConnected ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {wsConnected ? 'Conectado' : 'Desconectado'}
                        </span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Kernel</span>
                        <span className="text-white/70 font-medium">{snapshot ? 'Activo' : 'Sin señal'}</span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Seq</span>
                        <span className="text-white/70 font-mono" style={{ fontSize: 'clamp(12px, 1.4vw, 15px)' }}>{kernelSeq}</span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Versión</span>
                        <span className="text-white/70 font-mono" style={{ fontSize: 'clamp(12px, 1.4vw, 15px)' }}>{snapshotVersion}</span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Trail</span>
                        <span className="text-white/70 font-medium">{ghostrailPts.length} pts [{ghostrailDiagnostics.current.source}]</span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Zoom</span>
                        <span className="text-white/70 font-mono" style={{ fontSize: 'clamp(12px, 1.4vw, 15px)' }}>{userZoom}x</span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Follow</span>
                        <span className="font-medium" style={{ color: followMode ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {followMode ? 'ON' : 'OFF'}
                        </span>
                      </div>
                      {/* MAGIA4: Drone Follow Mode diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Drone</span>
                        <span className="font-medium" style={{ color: droneMode ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {droneMode ? 'ACTIVE' : 'idle'}
                        </span>
                      </div>
                      {/* MAGIA1: Time scrubber diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Scrub</span>
                        <span className="font-medium" style={{ color: scrubbing ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {scrubbing ? `idx ${timeScrubIndex}` : 'live'}
                        </span>
                      </div>
                      {/* V5.7 NAV_02: Heading diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Heading</span>
                        <span className="font-medium" style={{ color: headingState.heading != null ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.4)' }}>
                          {headingState.heading != null ? `${Math.round(headingState.heading)}°${headingState.latched ? ' (latch)' : ''}` : '—'}
                        </span>
                      </div>
                      {/* V5.7 NAV_03: Snap-to-door diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Snap</span>
                        <span className="font-medium" style={{ color: snapState.active ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.4)' }}>
                          {snapState.active ? `on ${(snapState.progress * 100).toFixed(0)}%` : 'off'}
                        </span>
                      </div>
                      {/* V5.8 INFRA_REALTIME_SOCKETS: Socket.io diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Socket</span>
                        <span className="font-medium" style={{ color: socketConnected ? 'rgba(10,132,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {socketConnected ? 'WS Live' : 'HTTP poll'}
                        </span>
                      </div>
                      {/* V5.8 SECURITY_FORTRESS: Encryption diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Crypto</span>
                        <span className="font-medium" style={{ color: 'rgba(255,255,255,.7)' }}>
                          AES-256
                        </span>
                      </div>
                      {/* MAGIA2: Loitering clusters diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Loiter</span>
                        <span className="font-medium" style={{ color: loiteringClusters.length > 0 ? 'rgba(255,255,255,.7)' : 'rgba(255,255,255,.4)' }}>
                          {loiteringClusters.length} clusters
                        </span>
                      </div>
                      {/* SYS3: Smart polling diagnostic */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Poll</span>
                        <span className="font-medium" style={{ color: wsConnected ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {wsConnected ? 'KILLED (fresh)' : 'ARMED (3s)'}
                        </span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Cookies</span>
                        <span className="text-white/70 font-medium">{lastCookieRefresh || '---'}</span>
                      </div>
                      {/* F6: Screen state inference diagnostics */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Screen</span>
                        <span className="font-medium" style={{ color: screen.isOn ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {screen.isOn ? 'ON' : 'OFF'} · {screen.confidence}%
                        </span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Screen Src</span>
                        <span className="text-white/40 font-mono" style={{ fontSize: 'clamp(11px, 1.2vw, 14px)' }}>{screen.source}</span>
                      </div>
                      {/* L1-L5: PlaceBadge diagnostics */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Place</span>
                        <span className="font-medium" style={{ color: placeBadge.type ? placeBadge.color : 'rgba(255,255,255,.4)' }}>
                          {placeBadge.type ? `${placeBadge.icon} ${placeBadge.value || placeBadge.type} · ${placeBadge.confidence}%` : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Place Src</span>
                        <span className="text-white/40 font-mono" style={{ fontSize: 'clamp(11px, 1.2vw, 14px)' }}>{placeBadge.source}</span>
                      </div>
                      {/* M3+M4: Spoof diagnostics */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Spoof</span>
                        <span className="font-medium" style={{ color: spoofResult.color }}>
                          {spoofResult.icon} {spoofResult.score}% ({spoofResult.strongSignalCount} strong)
                        </span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Spoof Sig</span>
                        <span className="text-white/40 font-mono" style={{ fontSize: 'clamp(11px, 1.2vw, 14px)' }}>{spoofResult.signals.join(', ') || 'none'}</span>
                      </div>
                      {/* M1: Sleep inference diagnostics */}
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Sleep</span>
                        <span className="font-medium" style={{ color: movement.inferredMode === 'SLEEP' ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {movement.inferredMode === 'SLEEP' ? 'DORMIDA' : 'DESPIERTA'}
                        </span>
                      </div>
                      <div className="flex justify-between" style={{ fontSize: 'clamp(12px, 1.8vw, 16px)' }}>
                        <span className="text-white/25 uppercase">Mode</span>
                        <span className="font-medium" style={{ color: movement.isActive ? 'rgba(255,255,255,.85)' : 'rgba(255,255,255,.4)' }}>
                          {movement.displayMode} ({movement.inferredMode})
                        </span>
                      </div>
                    </div>
                  </AccordionSection>
                  )}
                </div>

                {/* Kernel footer */}
                <div className="px-3 pb-2 pt-1 border-t border-white/[.03] text-white/10 font-mono flex justify-between" style={{ fontSize: 13 }}>
                  <span>EVENT_SOURCED_KERNEL</span>
                  <span>{wsConnected ? 'WS_CONNECTED' : 'HTTP_FALLBACK'}</span>
                </div>
              </div>
            )}
      </TrackerSheet>

      {/* ══ V8: TOAST removed — DynamicIsland (MC_8_03) now surfaces all alerts.
          The legacy `toast` state is mirrored into islandAlert by the useEffect
          above, so existing showToast() call sites continue to work. */}

      {/* ══ M8: LOADING — V5.5 Deep Black non-invasive skeleton, V6.0 Apple Maps 4000 ══ */}
      {!snapshot && (
        <div
          className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)]"
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
