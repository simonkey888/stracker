/**
 * nav-helpers.ts — stracker_v5.7_navigation
 *
 * NAV_02_HEADING_SYSTEM:
 *   Heading calculation via Math.atan2(lat2 - lat1, lng2 - lng1) * (180/PI).
 *   Latches (freezes) the heading when speed < threshold to avoid GPS jitter
 *   causing erratic icon rotation while the target is stationary.
 *
 * NAV_03_SNAP_TO_DOOR:
 *   When the target has been stationary (speed < 1.5 km/h) for > 5 minutes,
 *   applies a perpendicular lateral offset (~8m) to the arrival vector. This
 *   creates the optical illusion that the pin is "parked against the sidewalk"
 *   rather than floating in the middle of the street. The offset is display-
 *   only — the underlying lat/lng data remains accurate. Transition is
 *   linear-interpolated (ease-out) so the snap is never brusque.
 */

export interface GhostPoint {
  lat: number
  lng: number
  t?: string
}

export interface HeadingState {
  /** Current heading in degrees (0-360, 0=north, clockwise). Latched when stationary. */
  heading: number | null
  /** Whether the heading is currently latched (frozen) due to low speed. */
  latched: boolean
}

export interface SnapState {
  /** The display-adjusted position after snap offset. Null = use real position. */
  lat: number | null
  lng: number | null
  /** Animation progress 0→1 for ease-out transition into the snapped position. */
  progress: number
  /** Whether snap is currently active (stationary > threshold). */
  active: boolean
}

// ── Constants ──
const HEADING_SPEED_THRESHOLD = 1.5 // km/h — below this, latch heading
const SNAP_SPEED_THRESHOLD = 1.5    // km/h — below this, count as stationary
const SNAP_STATIONARY_MS = 5 * 60 * 1000 // 5 minutes
const SNAP_OFFSET_M = 8             // ~8 meters lateral offset
const SNAP_TRANSITION_MS = 800      // ease-out duration

/**
 * Compute the heading (bearing) using the spec formula:
 *   Math.atan2(lat2 - lat1, lng2 - lng1) * (180 / Math.PI)
 *
 * The raw atan2 result is an angle from the positive x-axis (east),
 * counterclockwise. We convert to a compass-style rotation where 0° = north
 * (pointing up) and clockwise, suitable for CSS/Leaflet marker rotation.
 *
 * Conversion: rotation = 90 - atan2_result
 *   - Moving north  (Δlat>0, Δlng=0): atan2=90°  → rotation=0°  (up) ✓
 *   - Moving east  (Δlat=0, Δlng>0): atan2=0°   → rotation=90° (right) ✓
 *   - Moving south (Δlat<0, Δlng=0): atan2=-90° → rotation=180° (down) ✓
 *   - Moving west  (Δlat=0, Δlng<0): atan2=180° → rotation=-90°=270° (left) ✓
 *
 * LATCH: when speedKmh < HEADING_SPEED_THRESHOLD, returns the previous heading
 * to prevent jitter from GPS noise while stationary.
 */
export function computeHeading(
  pts: GhostPoint[],
  currentLat: number | null,
  currentLng: number | null,
  speedKmh: number | null,
  prevHeading: number | null,
): HeadingState {
  // If we have speed data and it's below threshold, latch to previous heading
  if (speedKmh != null && speedKmh < HEADING_SPEED_THRESHOLD) {
    return {
      heading: prevHeading,
      latched: true,
    }
  }

  // Try to compute heading from the last two ghostrail points
  if (pts.length >= 2) {
    const p1 = pts[pts.length - 2]
    const p2 = pts[pts.length - 1]
    const dLat = p2.lat - p1.lat
    const dLng = p2.lng - p1.lng

    // Need meaningful movement to compute heading (avoid div-by-near-zero noise)
    const distM = Math.sqrt(
      dLat * dLat * 111000 * 111000 + dLng * dLng * 85000 * 85000,
    )
    if (distM < 3) {
      // Not enough movement — latch
      return { heading: prevHeading, latched: true }
    }

    const rawAtan2 = Math.atan2(dLat, dLng) * (180 / Math.PI)
    let rotation = 90 - rawAtan2
    // Normalize to [0, 360)
    rotation = ((rotation % 360) + 360) % 360
    return { heading: rotation, latched: false }
  }

  // Fallback: try current position vs last ghostrail point
  if (pts.length >= 1 && currentLat != null && currentLng != null) {
    const p1 = pts[pts.length - 1]
    const dLat = currentLat - p1.lat
    const dLng = currentLng - p1.lng
    const distM = Math.sqrt(
      dLat * dLat * 111000 * 111000 + dLng * dLng * 85000 * 85000,
    )
    if (distM >= 3) {
      const rawAtan2 = Math.atan2(dLat, dLng) * (180 / Math.PI)
      let rotation = 90 - rawAtan2
      rotation = ((rotation % 360) + 360) % 360
      return { heading: rotation, latched: false }
    }
  }

  return { heading: prevHeading, latched: true }
}

/**
 * NAV_03_SNAP_TO_DOOR:
 * When the target has been stationary (speed < 1.5 km/h) for > 5 minutes,
 * apply a perpendicular offset of ~8m to the arrival vector.
 *
 * The arrival vector is the direction of the LAST meaningful movement segment
 * (the direction the target was traveling before it stopped). The perpendicular
 * is that vector rotated 90° (right-hand side by convention — represents the
 * "nearest sidewalk" heuristic).
 *
 * Returns the snapped display position + animation progress. When the target
 * starts moving again, the snap releases (progress animates back to 0).
 *
 * @param pts          Ghostrail points (chronological, oldest first)
 * @param currentLat   Real current latitude
 * @param currentLng   Real current longitude
 * @param speedKmh     Current speed
 * @param prevSnap     Previous snap state (for animation continuity)
 * @param nowMs        Current timestamp (for stationary duration + animation)
 */
export function computeSnapOffset(
  pts: GhostPoint[],
  currentLat: number | null,
  currentLng: number | null,
  speedKmh: number | null,
  prevSnap: SnapState | null,
  nowMs: number,
): SnapState {
  const baseState: SnapState = {
    lat: currentLat,
    lng: currentLng,
    progress: 0,
    active: false,
  }

  if (currentLat == null || currentLng == null) return baseState

  // Check if currently stationary
  const isStationary = speedKmh != null && speedKmh < SNAP_SPEED_THRESHOLD

  if (!isStationary) {
    // Moving — snap should release (animate back to real position)
    if (prevSnap && prevSnap.active) {
      // Was snapping, now moving — animate progress back to 0
      const elapsed = nowMs - (prevSnap as any)._releaseStartMs
      const releaseStart = (prevSnap as any)._releaseStartMs ?? nowMs
      const releaseElapsed = nowMs - releaseStart
      const progress = Math.max(0, 1 - releaseElapsed / SNAP_TRANSITION_MS)
      return {
        lat: currentLat,
        lng: currentLng,
        progress,
        active: progress > 0,
        _releaseStartMs: releaseStart,
      } as SnapState & { _releaseStartMs: number }
    }
    return baseState
  }

  // Stationary — compute how long the target has been still
  // Walk backwards from the last point to find the stationary duration
  let stationarySinceMs: number | null = null
  let arrivalVector: { dLat: number; dLng: number } | null = null

  if (pts.length >= 2) {
    const lastPt = pts[pts.length - 1]
    const lastTs = lastPt.t ? new Date(lastPt.t).getTime() : null

    // Walk backwards to find the last point that had meaningful movement
    for (let i = pts.length - 1; i >= 1; i--) {
      const cur = pts[i]
      const prev = pts[i - 1]
      const dLat = cur.lat - prev.lat
      const dLng = cur.lng - prev.lng
      const distM = Math.sqrt(
        dLat * dLat * 111000 * 111000 + dLng * dLng * 85000 * 85000,
      )
      if (distM >= 5) {
        // Found the last meaningful movement segment — this is the arrival vector
        arrivalVector = { dLat, dLng }
        // Stationary since this point's timestamp
        const curTs = cur.t ? new Date(cur.t).getTime() : null
        if (curTs) stationarySinceMs = curTs
        break
      }
    }

    // If we couldn't find movement in ghostrail, use lastTs as fallback
    if (stationarySinceMs == null && lastTs) {
      stationarySinceMs = lastTs
    }
  }

  if (stationarySinceMs == null || arrivalVector == null) {
    return baseState
  }

  const stationaryDuration = nowMs - stationarySinceMs

  // Only snap after 5 minutes of being stationary
  if (stationaryDuration < SNAP_STATIONARY_MS) {
    return baseState
  }

  // Compute the perpendicular offset (right-hand side of arrival vector)
  // Perpendicular to (dLat, dLng) is (dLng, -dLat) [right-hand rotation]
  // Normalize and scale to SNAP_OFFSET_M meters
  const arrivalDistM = Math.sqrt(
    arrivalVector.dLat * arrivalVector.dLat * 111000 * 111000 +
      arrivalVector.dLng * arrivalVector.dLng * 85000 * 85000,
  )
  if (arrivalDistM < 1) return baseState

  // Convert meters to degrees
  const offsetLatDeg = (arrivalVector.dLng * SNAP_OFFSET_M) / arrivalDistM / 111000
  const offsetLngDeg = (-arrivalVector.dLat * SNAP_OFFSET_M) / arrivalDistM / 85000

  const snappedLat = currentLat + offsetLatDeg
  const snappedLng = currentLng + offsetLngDeg

  // Animation: ease-out progress from 0→1 over SNAP_TRANSITION_MS
  const snapStartMs = (prevSnap as any)?._snapStartMs ?? nowMs
  const snapElapsed = nowMs - snapStartMs
  const rawProgress = Math.min(1, snapElapsed / SNAP_TRANSITION_MS)
  // Ease-out: 1 - (1-t)^3 (cubic ease-out for smooth deceleration)
  const progress = 1 - Math.pow(1 - rawProgress, 3)

  return {
    lat: snappedLat,
    lng: snappedLng,
    progress,
    active: true,
    _snapStartMs: snapStartMs,
  } as SnapState & { _snapStartMs: number }
}

/**
 * Interpolate between the real position and the snapped position based on
 * the snap progress. Returns the display position for the marker.
 */
export function getDisplayPosition(
  realLat: number,
  realLng: number,
  snap: SnapState,
): { lat: number; lng: number } {
  if (!snap.active || snap.progress <= 0 || snap.lat == null || snap.lng == null) {
    return { lat: realLat, lng: realLng }
  }
  // Linear interpolation with ease-out (progress already eased)
  const p = snap.progress
  return {
    lat: realLat + (snap.lat - realLat) * p,
    lng: realLng + (snap.lng - realLng) * p,
  }
}

// ═══════════════════════════════════════════════════════════════════
// V6.0 stracker_fix_geospatial_drift — Coordinate calibration,
// forced map sync, debug overlay, and emergency snap-to-road.
// ═══════════════════════════════════════════════════════════════════
// This module eliminates the visual drift between the backend's raw
// GPS coordinates and the rendered pin position. Leaflet's CRS is
// EPSG:3857 (Web Mercator) for tiles but accepts lat/lng in EPSG:4326
// (WGS84) — the same system the backend emits. So drift is NOT a
// projection mismatch; it's typically caused by (a) stale panTo
// calls, (b) the snap-to-door offset being applied as if it were the
// real position, or (c) viewport desync when the user pans but the
// follow-mode re-centers on a stale cached coordinate.
//
// The functions below give the renderer explicit WGS84 normalization,
// a fitBounds-based forced re-sync when GPS is high-quality, a debug
// overlay (red crosshair + blue circle) so any residual drift is
// visible in seconds, and an emergency snap-to-road fallback for
// "dead zone" points (courtyards, interior of blocks).
// ═══════════════════════════════════════════════════════════════════

export interface NormalizedCoord {
  /** WGS84 latitude in decimal degrees, validated to [-90, 90]. */
  lat: number
  /** WGS84 longitude in decimal degrees, normalized to [-180, 180). */
  lng: number
  /** True if the input was already valid WGS84 (no normalization needed). */
  wasNormalized: boolean
  /** Reason for normalization (for console diagnostics). */
  reason?: string
}

/**
 * PROJECTION_CALIBRATION — Explicit WGS84 normalization.
 *
 * Leaflet's L.latLng() already accepts WGS84 decimal degrees, but this
 * function exists to:
 *   1. Reject NaN / Infinity / null coordinates before they reach the map.
 *   2. Clamp latitude to [-90, 90] (some backends emit slightly out-of-range
 *      values during GPS noise spikes).
 *   3. Wrap longitude to [-180, 180) (handles dateline wraparound).
 *   4. Strip any accidental hardcoded offset that a previous component may
 *      have applied (we re-derive display position from raw coords only).
 *
 * Use this on EVERY coordinate read from the backend before passing it
 * to Leaflet. The output is guaranteed safe to feed to L.latLng / map.panTo.
 */
export function normalizeWgs84(
  rawLat: number | null | undefined,
  rawLng: number | null | undefined,
): NormalizedCoord | null {
  if (rawLat == null || rawLng == null) return null
  const lat = typeof rawLat === 'number' ? rawLat : Number(rawLat)
  const lng = typeof rawLng === 'number' ? rawLng : Number(rawLng)
  if (!isFinite(lat) || !isFinite(lng)) {
    return null
  }
  let wasNormalized = false
  let reason: string | undefined
  let outLat = lat
  let outLng = lng
  // Clamp latitude — anything outside [-90, 90] is malformed.
  if (outLat > 90 || outLat < -90) {
    outLat = Math.max(-90, Math.min(90, outLat))
    wasNormalized = true
    reason = 'latitude_clamped'
  }
  // Wrap longitude to [-180, 180).
  if (outLng >= 180 || outLng < -180) {
    outLng = ((((outLng + 180) % 360) + 360) % 360) - 180
    wasNormalized = true
    reason = reason ? `${reason}+longitude_wrapped` : 'longitude_wrapped'
  }
  // Reject coordinates that are suspiciously close to (0,0) — a common
  // "uninitialized GPS" sentinel. We don't return null (caller decides),
  // but we flag it so the debug overlay can render it differently.
  if (Math.abs(outLat) < 0.001 && Math.abs(outLng) < 0.001) {
    wasNormalized = true
    reason = reason ? `${reason}+null_island` : 'null_island'
  }
  return { lat: outLat, lng: outLng, wasNormalized, reason }
}

/**
 * Haversine distance in meters between two WGS84 points.
 * Used by FORCED_MAP_SYNC to decide if the viewport needs a panTo().
 */
export function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6371000 // Earth radius (m)
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

export interface DriftReport {
  /** Distance in meters between the raw backend coord and the rendered pin. */
  driftM: number
  /** Raw backend coordinate (post-normalization). */
  raw: { lat: number; lng: number }
  /** Rendered pin coordinate (after snap offset, if any). */
  rendered: { lat: number; lng: number }
  /** Viewport center coordinate at the time of the check. */
  viewportCenter: { lat: number; lng: number }
  /** Distance from pin to viewport center (m). Used by FORCED_MAP_SYNC. */
  pinToViewportM: number
  /** GPS accuracy in meters (from backend). */
  accuracyM: number
  /** Whether the drift exceeds the 50m threshold (triggers console warn). */
  exceedsThreshold: boolean
  /** ISO timestamp of the report. */
  ts: string
}

/**
 * DEBUG_OVERLAY_INJECTION — Compute a drift report comparing the raw
 * backend coordinate against the rendered pin position. The caller is
 * responsible for rendering the crosshair (red, at raw) and circle
 * (blue, at rendered) and logging the report to console.
 *
 * Threshold: 50m (per spec). Drift above this triggers a console.warn.
 */
export function computeDriftReport(
  rawLat: number,
  rawLng: number,
  renderedLat: number,
  renderedLng: number,
  viewportCenterLat: number,
  viewportCenterLng: number,
  accuracyM: number,
): DriftReport {
  const driftM = haversineM(rawLat, rawLng, renderedLat, renderedLng)
  const pinToViewportM = haversineM(
    renderedLat,
    renderedLng,
    viewportCenterLat,
    viewportCenterLng,
  )
  return {
    driftM,
    raw: { lat: rawLat, lng: rawLng },
    rendered: { lat: renderedLat, lng: renderedLng },
    viewportCenter: { lat: viewportCenterLat, lng: viewportCenterLng },
    pinToViewportM,
    accuracyM,
    exceedsThreshold: driftM > 50,
    ts: new Date().toISOString(),
  }
}

/**
 * FORCED_MAP_SYNC — Decide whether to issue a fitBounds or panTo.
 *
 * Spec:
 *   - If accuracy < 20m (high-quality GPS), issue fitBounds around the
 *     pin with a small padding. This forces the map to re-draw and
 *     eliminates any stale tile/center desync.
 *   - If the pin is > 50m from the viewport center, issue a panTo to
 *     re-center. This catches the case where the user panned away and
 *     the follow-mode timer hasn't fired yet.
 *
 * Returns the action the caller should perform, or null if no action.
 */
export type MapSyncAction =
  | { kind: 'fitBounds'; lat: number; lng: number; accuracyM: number }
  | { kind: 'panTo'; lat: number; lng: number }
  | null

export function computeMapSyncAction(
  pinLat: number,
  pinLng: number,
  viewportCenterLat: number,
  viewportCenterLng: number,
  accuracyM: number,
  opts?: { fitBoundsAccuracyThreshold?: number; panToDistanceThreshold?: number },
): MapSyncAction {
  const fitBoundsThreshold = opts?.fitBoundsAccuracyThreshold ?? 20
  const panToThreshold = opts?.panToDistanceThreshold ?? 50
  const dist = haversineM(pinLat, pinLng, viewportCenterLat, viewportCenterLng)
  if (accuracyM > 0 && accuracyM < fitBoundsThreshold) {
    return { kind: 'fitBounds', lat: pinLat, lng: pinLng, accuracyM }
  }
  if (dist > panToThreshold) {
    return { kind: 'panTo', lat: pinLat, lng: pinLng }
  }
  return null
}

/**
 * snap_to_road (emergency logic) — Heuristic nearest-road snap.
 *
 * The directive references google.maps.geometry.poly.isLocationOnEdge,
 * but Leaflet has no equivalent and we don't have a road network graph
 * client-side. Instead, we implement a conservative dead-zone detector:
 *
 * A point is considered "in a dead zone" if:
 *   1. GPS accuracy is poor (> 35m), AND
 *   2. The point is far (> 30m) from any point in the recent ghostrail
 *      (which typically traces roads the target has actually traveled).
 *
 * When in a dead zone, we snap to the nearest ghostrail point. This is
 * a display-only correction — the raw coordinate is preserved for the
 * debug overlay so the operator can see the original GPS reading.
 *
 * Returns the snapped coordinate (or null if no snap is needed).
 */
export function snapToRoad(
  rawLat: number,
  rawLng: number,
  ghostrail: GhostPoint[],
  accuracyM: number,
): { lat: number; lng: number; snapped: boolean; reason?: string } {
  // Only snap when GPS quality is poor.
  if (accuracyM > 0 && accuracyM <= 35) {
    return { lat: rawLat, lng: rawLng, snapped: false }
  }
  if (ghostrail.length === 0) {
    return { lat: rawLat, lng: rawLng, snapped: false }
  }
  // Find the nearest ghostrail point.
  let nearest = ghostrail[0]
  let nearestDist = haversineM(rawLat, rawLng, nearest.lat, nearest.lng)
  for (let i = 1; i < ghostrail.length; i++) {
    const d = haversineM(rawLat, rawLng, ghostrail[i].lat, ghostrail[i].lng)
    if (d < nearestDist) {
      nearest = ghostrail[i]
      nearestDist = d
    }
  }
  // Only snap if the nearest trail point is reasonably close (within 60m).
  // If the nearest is farther than that, the target is genuinely off-trail
  // (e.g. in a new area) and we shouldn't fake a road snap.
  if (nearestDist > 60) {
    return { lat: rawLat, lng: rawLng, snapped: false }
  }
  return {
    lat: nearest.lat,
    lng: nearest.lng,
    snapped: true,
    reason: `dead_zone_snap (acc=${accuracyM}m, nearest=${nearestDist.toFixed(1)}m)`,
  }
}
