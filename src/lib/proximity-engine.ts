// ════════════════════════════════════════════════════════════════
// PROXIMITY ENGINE — Geofence Detection & Arrival/Departure
// ════════════════════════════════════════════════════════════════
//
// Pure function module for computing proximity data relative to
// a "home" geofence. Determines distance, bearing, direction of
// travel, and estimated time of arrival.
//
// Pipeline:
//   [Current Position] + [Home Geofence]
//         ↓
//   [Haversine Distance]
//         ↓
//   [Bearing Computation]
//         ↓
//   [Direction Classification] (approaching / departing / stationary)
//         ↓
//   [ETA Estimation]
//         ↓
//   [ProximityResult]
//
// ════════════════════════════════════════════════════════════════

// ── DEFAULT HOME GEOFENCE ──
// Buenos Aires default (same as map default center)

export const DEFAULT_HOME = {
  lat: -34.6037,
  lng: -58.3816,
  radiusM: 200,
} as const

// ── TYPES ──

export interface ProximityResult {
  distanceM: number         // Distance in meters to home center
  bearingDeg: number        // Bearing from current position to home (0-360°)
  isNearHome: boolean       // Within 200m radius
  isAtHome: boolean         // Within 50m radius
  etaMinutes: number | null // Estimated time of arrival (null if STATIONARY or speed=0)
  direction: 'approaching' | 'departing' | 'stationary'  // Movement direction relative to home
}

export interface ProximityParams {
  currentLat: number
  currentLng: number
  homeLat: number
  homeLng: number
  speedKmh: number | null
  heading: number | null
  movementState: string | null
}

// ── HAVERSINE FORMULA ──
// Computes great-circle distance between two points on Earth
// Returns distance in meters

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000 // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── BEARING COMPUTATION ──
// Computes the initial bearing (forward azimuth) from point A to point B
// Returns bearing in degrees (0-360°), where 0° = North, 90° = East

export function computeBearing(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): number {
  const dLng = (toLng - fromLng) * Math.PI / 180
  const lat1 = fromLat * Math.PI / 180
  const lat2 = toLat * Math.PI / 180

  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)

  const bearingRad = Math.atan2(y, x)
  const bearingDeg = (bearingRad * 180 / Math.PI + 360) % 360

  return bearingDeg
}

// ── ANGLE DIFFERENCE ──
// Smallest angular difference between two bearings (0-180°)

function angleDiff(bearingA: number, bearingB: number): number {
  let diff = ((bearingB - bearingA) % 360 + 540) % 360 - 180
  return Math.abs(diff)
}

// ── DIRECTION CLASSIFICATION ──
// Determines if the entity is approaching, departing, or stationary
// relative to the home geofence

function classifyDirection(
  bearingToHome: number,
  heading: number | null,
  speedKmh: number | null,
  movementState: string | null
): 'approaching' | 'departing' | 'stationary' {
  // If speed is 0 or movementState is STATIONARY → stationary
  if (movementState === 'STATIONARY') return 'stationary'
  if (speedKmh !== null && speedKmh <= 0) return 'stationary'

  // If heading is available: compare heading with bearing to home
  if (heading !== null) {
    // Angle between heading direction and bearing to home
    const diff = angleDiff(heading, bearingToHome)
    // If heading is within 90° of bearing to home → approaching
    // If heading is more than 90° away → departing
    if (diff < 90) return 'approaching'
    return 'departing'
  }

  // No heading and no clear direction info → default stationary
  return 'stationary'
}

// ── ETA COMPUTATION ──
// Estimates time of arrival at home in minutes
// Returns null if STATIONARY, speed ≤ 0, or not approaching

function computeEta(
  distanceM: number,
  speedKmh: number | null,
  movementState: string | null,
  direction: 'approaching' | 'departing' | 'stationary'
): number | null {
  // No ETA if stationary or no speed
  if (movementState === 'STATIONARY') return null
  if (speedKmh === null || speedKmh <= 0) return null

  // ETA = (distance in km) / speed in km/h * 60 min/hour
  const etaMinutes = (distanceM / 1000) / speedKmh * 60

  // Round to 1 decimal place
  return Math.round(etaMinutes * 10) / 10
}

// ── MAIN PROXIMITY COMPUTATION ──
// Computes comprehensive proximity data relative to the home geofence

export function computeProximity(params: ProximityParams): ProximityResult {
  const {
    currentLat,
    currentLng,
    homeLat,
    homeLng,
    speedKmh,
    heading,
    movementState,
  } = params

  // 1. Distance to home center (haversine)
  const distanceM = haversine(currentLat, currentLng, homeLat, homeLng)

  // 2. Bearing from current position to home
  const bearingDeg = computeBearing(currentLat, currentLng, homeLat, homeLng)

  // 3. Proximity flags
  const isNearHome = distanceM <= 200
  const isAtHome = distanceM <= 50

  // 4. Direction classification
  const direction = classifyDirection(bearingDeg, heading, speedKmh, movementState)

  // 5. ETA estimation
  const etaMinutes = computeEta(distanceM, speedKmh, movementState, direction)

  return {
    distanceM: Math.round(distanceM * 10) / 10,  // Round to 0.1m precision
    bearingDeg: Math.round(bearingDeg * 10) / 10,  // Round to 0.1° precision
    isNearHome,
    isAtHome,
    etaMinutes,
    direction,
  }
}
