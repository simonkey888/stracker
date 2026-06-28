// ════════════════════════════════════════════════════════════════
// V3.1 SIGNAL INTELLIGENCE PIPELINE — STABLE
// ════════════════════════════════════════════════════════════════
//
// Architecture V3.1 (clean, honest, probabilistic):
//
//   [ DOM Extractor ]
//         ↓
//   [ Signal Parser ]
//         ↓
//   [ Normalized Event ]
//         ↓
//   [ Signal Intelligence Core ]
//       - classifier
//       - kalman filter
//       - anomaly engine
//         ↓
//   [ Scoring Layer ]
//         ↓
//   [ UI / Map Renderer ]
//
// REGLA DE ORO V3.1:
//   ❌ NO existe "pin exacto" si depende de WhatsApp snapshots
//   ❌ NO UI = truth · NO map state = truth · NO React state = truth
//   ✔ SIGNAL PIPELINE = TRUTH (estimación probabilística)
//   ✔ Última ubicación enviada = lo único real
//   ✔ Todo lo demás = estimación probabilística con scoring
//
// Pipeline stages:
//   1. RAW signal — what the client sends (lat, lng, accuracy, etc.)
//   2. NORMALIZED signal — parsed, timestamped, source-tagged
//   3. CLEANED signal — dedup, clamp impossible jumps, de-jitter
//   4. FILTERED signal — Kalman-lite smoothed position
//   5. CLASSIFIED signal — movement state + heading + speed + anomaly
//   6. SCORED signal — confidence + quality + tier + uncertainty radius
//
// V3.1 vs V3 differences:
//   - Honest probabilistic model (no "exact pin" pretense)
//   - Uncertainty radius visualization
//   - Snapshot-based, not live-tracking
//   - Scoring + anomaly + history only (no fake live detection)
//
// ════════════════════════════════════════════════════════════════

// ── TYPES ──

export type MovementState = 'STATIONARY' | 'SLOW' | 'WALKING' | 'VEHICULAR' | 'HIGH_SPEED' | 'ANOMALOUS' | 'UNKNOWN'
export type SignalQuality = 'CLEAN' | 'NOISY' | 'DEGRADED' | 'UNRELIABLE'
export type ConfidenceTier = 'reliable' | 'uncertain' | 'noisy' | 'invalid'
export type NormalizedSource = 'chrome_ext' | 'mobile_hook' | 'google_maps_link' | 'gps' | 'link_parser' | 'simulation' | 'api' | 'unknown'

export interface RawSignal {
  lat: number
  lng: number
  accuracy?: number | null
  speedKmh?: number | null
  battery?: number | null
  source: string
  observedAt: Date
}

export interface NormalizedSignal extends RawSignal {
  normalizedSource: NormalizedSource
  isValid: boolean
  validationFlags: string[]
}

export interface HistoricalPoint {
  lat: number
  lng: number
  observedAt: Date
  accuracy?: number | null
  speedKmh?: number | null
  confidence?: number | null
}

export interface FilteredSignal {
  lat: number
  lng: number
  kalmanGain: number      // 0-1, how much the filter trusted the new measurement
  smoothingApplied: number // meters of smoothing applied
  isClamped: boolean       // true if impossible jump was clamped
}

export interface ClassifiedSignal {
  movementState: MovementState
  heading: number | null    // degrees 0-360
  speedKmh: number | null
  headingChangeRate: number | null  // degrees per minute
  isTurning: boolean
  anomalyFlags: string[]    // reasons for ANOMALOUS classification
}

export interface SignalPipelineResult {
  raw: RawSignal
  normalized: NormalizedSignal
  filtered: FilteredSignal
  classified: ClassifiedSignal
  confidence: number        // 0-1
  signalQuality: SignalQuality
  confidenceTier: ConfidenceTier
  factors: ConfidenceFactorsV3
  isDuplicate: boolean      // true if position hasn't meaningfully changed
  // V3.1: Probabilistic truth model
  uncertaintyRadiusM: number  // estimated uncertainty radius in meters
  isEstimate: boolean         // true if position is an estimate (not confirmed GPS)
}

export interface ConfidenceFactorsV3 {
  // Source factors
  sourceTrusted: boolean
  sourceWeight: number       // 0-0.15

  // Accuracy factors
  hasAccuracy: boolean
  accuracyGood: boolean      // < 50m
  accuracyWeight: number     // 0-0.15

  // Plausibility factors
  coordsInRange: boolean
  speedPlausible: boolean
  plausibilityWeight: number // 0-0.10

  // Signal quality factors
  kalmanConfidence: number   // 0-1, how much the filter agreed with the measurement
  noiseLevel: number         // 0-1, estimated noise in the signal
  historicalConsistency: number // 0-1, how consistent with recent history
  signalQualityWeight: number  // 0-0.25

  // Movement coherence factors
  movementCoherent: boolean  // speed/heading match filter prediction
  coherenceWeight: number    // 0-0.15

  // Freshness
  freshnessWeight: number    // 0-0.20
}

// ── CONSTANTS ──

const TRUSTED_SOURCES: NormalizedSource[] = ['chrome_ext', 'mobile_hook', 'google_maps_link', 'gps']
const MAX_SPEED_KMH = 300
const MAX_ACCURACY = 5000
const IMPOSSIBLE_JUMP_SPEED_KMH = 200  // > 200km/h = impossible jump
const DUPLICATE_DISTANCE_METERS = 2     // < 2m = same position (duplicate)

// Movement classification thresholds (km/h)
const SPEED_THRESHOLDS = {
  STATIONARY: 2,    // below 2 km/h
  SLOW: 5,          // 2-5 km/h
  WALKING: 15,      // 5-15 km/h
  VEHICULAR: 120,   // 15-120 km/h
  // above 120 = HIGH_SPEED
}

// Source normalization map
const SOURCE_ALIASES: Record<string, NormalizedSource> = {
  'chrome_ext': 'chrome_ext',
  'chrome_extension': 'chrome_ext',
  'chrome': 'chrome_ext',
  'mobile_hook': 'mobile_hook',
  'mobile': 'mobile_hook',
  'google_maps_link': 'google_maps_link',
  'google_maps': 'google_maps_link',
  'maps_link': 'google_maps_link',
  'link_parser': 'link_parser',
  'link': 'link_parser',
  'gps': 'gps',
  'simulation': 'simulation',
  'sim': 'simulation',
  'simulate': 'simulation',
  'api': 'api',
  'cloud': 'api',
  'manual': 'api',
}

// Kalman filter parameters
const KALMAN_PROCESS_NOISE = 0.00001  // How much we expect position to change naturally (degrees)
const KALMAN_MEASUREMENT_NOISE_MIN = 0.00005  // Minimum measurement noise (degrees, ~5m)
const KALMAN_MEASUREMENT_NOISE_MAX = 0.005    // Maximum measurement noise (degrees, ~500m)

// ── STAGE 1: NORMALIZER ──
// Parse lat/lng, timestamp standardization, source tagging

export function normalizeSignal(raw: RawSignal): NormalizedSignal {
  const validationFlags: string[] = []

  // Source normalization
  const sourceKey = raw.source.toLowerCase().replace(/[^a-z_]/g, '')
  const normalizedSource = SOURCE_ALIASES[sourceKey] || 'unknown'

  // Validation
  const latValid = raw.lat >= -90 && raw.lat <= 90
  const lngValid = raw.lng >= -180 && raw.lng <= 180
  const coordsInRange = latValid && lngValid

  if (!latValid) validationFlags.push('LAT_OUT_OF_RANGE')
  if (!lngValid) validationFlags.push('LNG_OUT_OF_RANGE')
  if (raw.accuracy != null && raw.accuracy < 0) validationFlags.push('NEGATIVE_ACCURACY')
  if (raw.battery != null && (raw.battery < 0 || raw.battery > 100)) validationFlags.push('BATTERY_OUT_OF_RANGE')
  if (raw.speedKmh != null && raw.speedKmh < 0) validationFlags.push('NEGATIVE_SPEED')

  const isValid = coordsInRange && validationFlags.length === 0

  return {
    ...raw,
    normalizedSource,
    isValid,
    validationFlags,
  }
}

// ── STAGE 2: SIGNAL CLEANER ──
// Remove jitter noise, deduplicate same-position updates,
// clamp impossible jumps (>200km/h = invalid), smooth trajectory

export interface CleanSignalResult {
  lat: number
  lng: number
  isClamped: boolean
  isDuplicate: boolean
  clampReason?: string
}

export function cleanSignal(
  normalized: NormalizedSignal,
  history: HistoricalPoint[]
): CleanSignalResult {
  let { lat, lng } = normalized
  let isClamped = false
  let isDuplicate = false
  let clampReason: string | undefined

  // ── Deduplication check: same position? ──
  if (history.length > 0) {
    const prev = history[history.length - 1]
    const distM = haversineSimple(prev.lat, prev.lng, lat, lng)
    if (distM < DUPLICATE_DISTANCE_METERS) {
      isDuplicate = true
    }
  }

  // ── Impossible jump check (>200km/h = invalid) ──
  if (history.length > 0) {
    const prev = history[history.length - 1]
    const distM = haversineSimple(prev.lat, prev.lng, lat, lng)
    const timeDeltaH = (normalized.observedAt.getTime() - prev.observedAt.getTime()) / (1000 * 60 * 60)
    if (timeDeltaH > 0) {
      const impliedSpeedKmh = (distM / 1000) / timeDeltaH
      if (impliedSpeedKmh > IMPOSSIBLE_JUMP_SPEED_KMH) {
        // CLAMP: reject the jump, hold previous position
        isClamped = true
        clampReason = `IMPOSSIBLE_JUMP: ${Math.round(impliedSpeedKmh)}km/h`
        lat = prev.lat
        lng = prev.lng
      }
    }
  }

  return { lat, lng, isClamped, isDuplicate, clampReason }
}

// ── KALMAN-LITE FILTER ──
// Simple 2D Kalman filter for GPS coordinate smoothing
// State: [lat, lng] (we skip velocity estimation for simplicity and robustness)
// This prevents:
//   - GPS jitter at standstill
//   - Micro-bounces from noisy signals
//   - False movement detection from drift

interface KalmanState {
  lat: number
  lng: number
  pLat: number  // estimation error covariance
  pLng: number
  lastUpdate: number  // timestamp ms
}

export class KalmanFilter {
  private state: KalmanState | null = null

  /**
   * Reset the filter to a known position (used for first measurement)
   */
  reset(lat: number, lng: number): void {
    this.state = {
      lat,
      lng,
      pLat: KALMAN_MEASUREMENT_NOISE_MIN,
      pLng: KALMAN_MEASUREMENT_NOISE_MIN,
      lastUpdate: Date.now(),
    }
  }

  /**
   * Update the filter with a new GPS measurement
   * Returns the filtered position and how much the filter trusted the measurement
   */
  update(
    rawLat: number,
    rawLng: number,
    accuracyMeters: number | null | undefined,
    timestamp: number
  ): { lat: number; lng: number; gain: number; smoothingMeters: number } {
    // If no state yet, initialize with raw measurement
    if (!this.state) {
      this.reset(rawLat, rawLng)
      return { lat: rawLat, lng: rawLng, gain: 1.0, smoothingMeters: 0 }
    }

    // ── PREDICT ──
    // Time since last update (seconds)
    const dt = Math.max((timestamp - this.state.lastUpdate) / 1000, 0.1)

    // Process noise grows with time (position uncertainty increases)
    const processNoise = KALMAN_PROCESS_NOISE * Math.sqrt(dt / 60) // scale with sqrt of minutes
    const predictedPLat = this.state.pLat + processNoise
    const predictedPLng = this.state.pLng + processNoise

    // ── MEASUREMENT NOISE ──
    // Map accuracy (meters) to degrees and use as measurement noise
    // Higher accuracy = lower noise = filter trusts measurement more
    let measurementNoise: number
    if (accuracyMeters != null && accuracyMeters > 0 && accuracyMeters < MAX_ACCURACY) {
      // Convert meters to approximate degrees (at equator: 1° ≈ 111,320m)
      measurementNoise = Math.max(
        KALMAN_MEASUREMENT_NOISE_MIN,
        Math.min(KALMAN_MEASUREMENT_NOISE_MAX, accuracyMeters / 111320)
      )
    } else {
      // No accuracy info → assume moderate noise (~100m)
      measurementNoise = 100 / 111320
    }

    // ── UPDATE (Kalman gain) ──
    const kLat = predictedPLat / (predictedPLat + measurementNoise)
    const kLng = predictedPLng / (predictedPLng + measurementNoise)
    const avgGain = (kLat + kLng) / 2

    // ── CORRECT ──
    const filteredLat = this.state.lat + kLat * (rawLat - this.state.lat)
    const filteredLng = this.state.lng + kLng * (rawLng - this.state.lng)

    // Update covariance
    this.state = {
      lat: filteredLat,
      lng: filteredLng,
      pLat: (1 - kLat) * predictedPLat,
      pLng: (1 - kLng) * predictedPLng,
      lastUpdate: timestamp,
    }

    // Calculate how much smoothing was applied (meters)
    const dLat = (rawLat - filteredLat) * 111320
    const dLng = (rawLng - filteredLng) * 111320 * Math.cos(filteredLat * Math.PI / 180)
    const smoothingMeters = Math.sqrt(dLat * dLat + dLng * dLng)

    return { lat: filteredLat, lng: filteredLng, gain: avgGain, smoothingMeters }
  }

  /**
   * Get current filtered state (without update)
   */
  getState(): KalmanState | null {
    return this.state
  }
}

// ── MOVEMENT CLASSIFIER ──

export function classifyMovement(
  speedKmh: number | null,
  heading: number | null,
  headingChangeRate: number | null,
  kalmanGain: number,
  isClamped: boolean,
  noiseLevel: number,
  historicalConsistency: number
): ClassifiedSignal {
  const anomalyFlags: string[] = []
  let movementState: MovementState = 'UNKNOWN'
  const isTurning = headingChangeRate !== null && Math.abs(headingChangeRate) > 30 // 30°/min threshold

  // If signal was clamped (impossible jump), it's ANOMALOUS
  if (isClamped) {
    movementState = 'ANOMALOUS'
    anomalyFlags.push('IMPOSSIBLE_JUMP')
  }
  // High noise + low consistency = ANOMALOUS
  else if (noiseLevel > 0.8 && historicalConsistency < 0.2) {
    movementState = 'ANOMALOUS'
    anomalyFlags.push('HIGH_NOISE_LOW_CONSISTENCY')
  }
  // Very erratic heading changes (spinning) = ANOMALOUS
  else if (headingChangeRate !== null && Math.abs(headingChangeRate) > 120) {
    movementState = 'ANOMALOUS'
    anomalyFlags.push('ERRATIC_HEADING')
  }
  else if (speedKmh !== null) {
    if (speedKmh < SPEED_THRESHOLDS.STATIONARY) movementState = 'STATIONARY'
    else if (speedKmh < SPEED_THRESHOLDS.SLOW) movementState = 'SLOW'
    else if (speedKmh < SPEED_THRESHOLDS.WALKING) movementState = 'WALKING'
    else if (speedKmh < SPEED_THRESHOLDS.VEHICULAR) movementState = 'VEHICULAR'
    else movementState = 'HIGH_SPEED'

    // Cross-check: if movement says HIGH_SPEED but filter rejected it (low gain), flag anomalous
    if (movementState === 'HIGH_SPEED' && kalmanGain < 0.2) {
      movementState = 'ANOMALOUS'
      anomalyFlags.push('HIGH_SPEED_LOW_GAIN')
    }
  } else {
    // No speed data — try to infer from Kalman gain
    // High gain = filter trusted measurement = likely consistent movement
    // Low gain = filter rejected measurement = likely noise/stationary
    if (kalmanGain < 0.3) movementState = 'STATIONARY'  // filter mostly ignored the reading
    else if (kalmanGain < 0.6) movementState = 'UNKNOWN'
    else movementState = 'UNKNOWN' // moderate gain without speed = can't classify confidently
  }

  return {
    movementState,
    heading,
    speedKmh,
    headingChangeRate,
    isTurning,
    anomalyFlags,
  }
}

// ── HEADING COMPUTATION ──

export function computeHeading(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = (toLng - fromLng) * Math.PI / 180
  const lat1 = fromLat * Math.PI / 180
  const lat2 = toLat * Math.PI / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360
}

// ── NOISE ESTIMATION ──
// Estimates noise level from recent historical points
// Returns 0 (clean) to 1 (very noisy)

export function estimateNoiseLevel(history: HistoricalPoint[]): number {
  if (history.length < 3) return 0.5 // insufficient data

  const recent = history.slice(-10) // last 10 points
  if (recent.length < 3) return 0.5

  // Calculate successive displacements
  const displacements: number[] = []
  for (let i = 1; i < recent.length; i++) {
    const dLat = (recent[i].lat - recent[i - 1].lat) * 111320
    const dLng = (recent[i].lng - recent[i - 1].lng) * 111320 * Math.cos(recent[i].lat * Math.PI / 180)
    displacements.push(Math.sqrt(dLat * dLat + dLng * dLng))
  }

  // Calculate variance of displacements
  const mean = displacements.reduce((a, b) => a + b, 0) / displacements.length
  const variance = displacements.reduce((a, b) => a + (b - mean) ** 2, 0) / displacements.length

  // Also check accuracy reports if available
  const accuracies = recent.filter(p => p.accuracy != null).map(p => p.accuracy!)
  const avgAccuracy = accuracies.length > 0 ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : 50

  // Normalize: low variance + good accuracy = clean (0), high variance + bad accuracy = noisy (1)
  const varianceScore = Math.min(1, Math.sqrt(variance) / 100) // 100m std dev = fully noisy
  const accuracyScore = Math.min(1, avgAccuracy / 200) // 200m avg accuracy = fully noisy

  return Math.min(1, (varianceScore * 0.6 + accuracyScore * 0.4))
}

// ── HISTORICAL CONSISTENCY ──
// How well does the new point fit the recent trajectory?
// Returns 0 (inconsistent / outlier) to 1 (perfectly consistent)

export function computeHistoricalConsistency(
  newLat: number,
  newLng: number,
  filteredLat: number,
  filteredLng: number,
  history: HistoricalPoint[]
): number {
  if (history.length < 2) return 0.5

  // Distance between raw signal and filtered prediction
  const dLat = (newLat - filteredLat) * 111320
  const dLng = (newLng - filteredLng) * 111320 * Math.cos(filteredLat * Math.PI / 180)
  const predictionError = Math.sqrt(dLat * dLat + dLng * dLng)

  // Compare with recent displacement pattern
  const recent = history.slice(-5)
  const displacements: number[] = []
  for (let i = 1; i < recent.length; i++) {
    const dl = (recent[i].lat - recent[i - 1].lat) * 111320
    const dn = (recent[i].lng - recent[i - 1].lng) * 111320 * Math.cos(recent[i].lat * Math.PI / 180)
    displacements.push(Math.sqrt(dl * dl + dn * dn))
  }

  const avgDisplacement = displacements.length > 0
    ? displacements.reduce((a, b) => a + b, 0) / displacements.length
    : 50

  // If prediction error is small relative to recent movement, it's consistent
  if (avgDisplacement < 1) {
    // Stationary — prediction error should be very small
    return predictionError < 20 ? 1.0 : predictionError < 50 ? 0.5 : 0.1
  }

  // Moving — allow prediction error proportional to displacement
  const ratio = predictionError / avgDisplacement
  if (ratio < 0.5) return 1.0
  if (ratio < 1.0) return 0.8
  if (ratio < 2.0) return 0.4
  return 0.1
}

// ── SIGNAL QUALITY CLASSIFICATION ──

export function classifySignalQuality(
  noiseLevel: number,
  kalmanGain: number,
  consistency: number
): SignalQuality {
  const qualityScore = (1 - noiseLevel) * 0.4 + kalmanGain * 0.3 + consistency * 0.3

  if (qualityScore >= 0.75) return 'CLEAN'
  if (qualityScore >= 0.50) return 'NOISY'
  if (qualityScore >= 0.25) return 'DEGRADED'
  return 'UNRELIABLE'
}

// ── CONFIDENCE TIER CLASSIFICATION ──
// Based on confidence score, provides human-readable tier

export function classifyConfidenceTier(
  confidence: number,
  signalQuality: SignalQuality
): ConfidenceTier {
  if (confidence >= 0.7 && signalQuality === 'CLEAN') return 'reliable'
  if (confidence >= 0.5 && (signalQuality === 'CLEAN' || signalQuality === 'NOISY')) return 'uncertain'
  if (confidence >= 0.25) return 'noisy'
  return 'invalid'
}

// ── V3 CONFIDENCE SCORING ──

export function computeConfidenceV3(
  source: string,
  accuracy: number | null | undefined,
  coordsInRange: boolean,
  speedPlausible: boolean,
  kalmanGain: number,
  noiseLevel: number,
  historicalConsistency: number,
  movementCoherent: boolean,
  stalenessMs: number
): { score: number; factors: ConfidenceFactorsV3 } {
  // ── Source trust (0 - 0.15) ──
  const sourceTrusted = TRUSTED_SOURCES.includes(source as NormalizedSource)
  const sourceWeight = sourceTrusted ? 0.15 : 0.03

  // ── Accuracy (0 - 0.15) ──
  const hasAccuracy = accuracy != null
  const accuracyGood = hasAccuracy && accuracy! <= 50
  const accuracyWeight = accuracyGood ? 0.15 : hasAccuracy ? 0.08 : 0.03

  // ── Plausibility (0 - 0.10) ──
  const plausibilityWeight = coordsInRange && speedPlausible ? 0.10 : 0.02

  // ── Signal quality (0 - 0.25) ──
  const kalmanConfidence = kalmanGain // 0-1, how much filter trusted the reading
  const signalQualityWeight = (kalmanConfidence * 0.4 + (1 - noiseLevel) * 0.35 + historicalConsistency * 0.25) * 0.25

  // ── Movement coherence (0 - 0.15) ──
  const coherenceWeight = movementCoherent ? 0.15 : 0.03

  // ── Freshness (0 - 0.20) ──
  let freshnessWeight: number
  if (stalenessMs < 30 * 1000) freshnessWeight = 0.20      // < 30s
  else if (stalenessMs < 2 * 60 * 1000) freshnessWeight = 0.15  // < 2min
  else if (stalenessMs < 15 * 60 * 1000) freshnessWeight = 0.08 // < 15min
  else freshnessWeight = 0.02                                   // stale

  const score = Math.max(0, Math.min(1,
    sourceWeight +
    accuracyWeight +
    plausibilityWeight +
    signalQualityWeight +
    coherenceWeight +
    freshnessWeight
  ))

  return {
    score: Math.round(score * 100) / 100,
    factors: {
      sourceTrusted,
      sourceWeight,
      hasAccuracy,
      accuracyGood,
      accuracyWeight,
      coordsInRange,
      speedPlausible,
      plausibilityWeight,
      kalmanConfidence,
      noiseLevel,
      historicalConsistency,
      signalQualityWeight,
      movementCoherent,
      coherenceWeight,
      freshnessWeight,
    },
  }
}

// ── FULL PIPELINE ──
// Takes a raw signal + historical context → returns complete pipeline result
// GPS → Normalize → Clean → Filter → Classify → Score → Tier

export function runSignalPipeline(
  raw: RawSignal,
  history: HistoricalPoint[],
  kalmanFilter: KalmanFilter
): SignalPipelineResult {
  const timestamp = raw.observedAt.getTime()

  // ── STAGE 1: NORMALIZE ──
  const normalized = normalizeSignal(raw)

  // ── STAGE 2: CLEAN ──
  const cleaned = cleanSignal(normalized, history)

  // ── STAGE 3: FILTER (Kalman) ──
  const filterResult = kalmanFilter.update(cleaned.lat, cleaned.lng, raw.accuracy, timestamp)
  const filtered: FilteredSignal = {
    lat: filterResult.lat,
    lng: filterResult.lng,
    kalmanGain: filterResult.gain,
    smoothingApplied: filterResult.smoothingMeters,
    isClamped: cleaned.isClamped,
  }

  // ── STAGE 4: COMPUTE SPEED (if not provided) ──
  let speedKmh = raw.speedKmh ?? null
  if (speedKmh === null && history.length > 0) {
    const prev = history[history.length - 1]
    const distM = haversineSimple(prev.lat, prev.lng, raw.lat, raw.lng)
    const deltaH = (timestamp - prev.observedAt.getTime()) / (1000 * 60 * 60)
    if (deltaH > 0) speedKmh = Math.round((distM / 1000 / deltaH) * 10) / 10
  }

  // ── STAGE 5: COMPUTE HEADING ──
  let heading: number | null = null
  let headingChangeRate: number | null = null
  if (history.length > 0) {
    const prev = history[history.length - 1]
    heading = computeHeading(prev.lat, prev.lng, raw.lat, raw.lng)

    // Heading change rate (degrees per minute)
    if (history.length > 1) {
      const prevPrev = history[history.length - 2]
      const prevHeading = computeHeading(prevPrev.lat, prevPrev.lng, prev.lat, prev.lng)
      const headingDiff = angleDiff(prevHeading, heading)
      const timeDiffMin = (raw.observedAt.getTime() - prevPrev.observedAt.getTime()) / (1000 * 60)
      if (timeDiffMin > 0) headingChangeRate = headingDiff / timeDiffMin
    }
  }

  // ── STAGE 6: SIGNAL QUALITY METRICS ──
  const noiseLevel = estimateNoiseLevel(history)
  const historicalConsistency = computeHistoricalConsistency(
    raw.lat, raw.lng, filtered.lat, filtered.lng, history
  )
  const signalQuality = classifySignalQuality(noiseLevel, filterResult.gain, historicalConsistency)

  // ── STAGE 7: CLASSIFY MOVEMENT ──
  const classified = classifyMovement(
    speedKmh,
    heading,
    headingChangeRate,
    filterResult.gain,
    cleaned.isClamped,
    noiseLevel,
    historicalConsistency
  )

  // ── STAGE 8: CONFIDENCE SCORING ──
  const coordsInRange = raw.lat >= -90 && raw.lat <= 90 && raw.lng >= -180 && raw.lng <= 180
  const speedPlausible = speedKmh === null || speedKmh <= MAX_SPEED_KMH

  // Movement coherence: does the raw speed match the filter's behavior?
  const movementCoherent = speedKmh !== null
    ? (speedKmh > SPEED_THRESHOLDS.STATIONARY && filterResult.gain > 0.3) ||
      (speedKmh <= SPEED_THRESHOLDS.STATIONARY && filterResult.gain < 0.7)
    : true // no speed data, assume coherent

  // Staleness from last historical point
  const stalenessMs = history.length > 0
    ? timestamp - history[history.length - 1].observedAt.getTime()
    : 0

  const { score, factors } = computeConfidenceV3(
    normalized.normalizedSource,
    raw.accuracy ?? null,
    coordsInRange,
    speedPlausible,
    filterResult.gain,
    noiseLevel,
    historicalConsistency,
    movementCoherent,
    stalenessMs
  )

  // ── STAGE 9: CONFIDENCE TIER ──
  const confidenceTier = classifyConfidenceTier(score, signalQuality)

  // ── STAGE 10: V3.1 UNCERTAINTY RADIUS ──
  // Probabilistic truth model: estimate the uncertainty radius
  // based on GPS accuracy, Kalman smoothing, confidence, and staleness
  let uncertaintyRadiusM: number
  if (raw.accuracy != null && raw.accuracy > 0) {
    // Start with GPS accuracy as baseline
    uncertaintyRadiusM = raw.accuracy
  } else {
    // No accuracy reported — estimate from confidence
    // Low confidence = large radius, high confidence = small radius
    uncertaintyRadiusM = 200 - score * 150  // ranges from 200m (score=0) to 50m (score=1)
  }

  // Expand radius if Kalman smoothed significantly (means we're less certain about true position)
  if (filterResult.smoothingMeters > 5) {
    uncertaintyRadiusM += filterResult.smoothingMeters * 0.5
  }

  // Expand if signal was clamped (impossible jump = position is uncertain)
  if (cleaned.isClamped) {
    uncertaintyRadiusM *= 2.0
  }

  // Expand if low confidence
  if (score < 0.4) {
    uncertaintyRadiusM *= 1.5
  }

  // Clamp to reasonable bounds
  uncertaintyRadiusM = Math.max(10, Math.min(2000, uncertaintyRadiusM))

  // A position is an estimate (not confirmed) if:
  // - Source is not direct GPS
  // - Or accuracy is > 100m
  // - Or signal was clamped (we're holding previous position)
  // - Or confidence < 0.5
  const isEstimate = normalized.normalizedSource !== 'gps'
    || (raw.accuracy != null && raw.accuracy > 100)
    || cleaned.isClamped
    || score < 0.5

  return {
    raw,
    normalized,
    filtered,
    classified,
    confidence: score,
    signalQuality,
    confidenceTier,
    factors,
    isDuplicate: cleaned.isDuplicate,
    uncertaintyRadiusM: Math.round(uncertaintyRadiusM),
    isEstimate,
  }
}

// ── HELPERS ──

function haversineSimple(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Smallest angle difference between two bearings (0-180) */
function angleDiff(a: number, b: number): number {
  let diff = ((b - a) % 360 + 540) % 360 - 180
  return Math.abs(diff)
}

// ── DISPLAY HELPERS ──

export function movementStateLabel(state: MovementState): string {
  switch (state) {
    case 'STATIONARY': return 'ESTACIONARIO'
    case 'SLOW': return 'LENTO'
    case 'WALKING': return 'CAMINANDO'
    case 'VEHICULAR': return 'VEHÍCULO'
    case 'HIGH_SPEED': return 'ALTA VELOCIDAD'
    case 'ANOMALOUS': return 'ANÓMALO'
    case 'UNKNOWN': return 'DESCONOCIDO'
  }
}

export function movementStateColor(state: MovementState): string {
  switch (state) {
    case 'STATIONARY': return 'text-zinc-400'
    case 'SLOW': return 'text-amber-400'
    case 'WALKING': return 'text-emerald-400'
    case 'VEHICULAR': return 'text-blue-400'
    case 'HIGH_SPEED': return 'text-red-400'
    case 'ANOMALOUS': return 'text-purple-400'
    case 'UNKNOWN': return 'text-zinc-500'
  }
}

export function movementStateBg(state: MovementState): string {
  switch (state) {
    case 'STATIONARY': return 'bg-zinc-500'
    case 'SLOW': return 'bg-amber-500'
    case 'WALKING': return 'bg-emerald-500'
    case 'VEHICULAR': return 'bg-blue-500'
    case 'HIGH_SPEED': return 'bg-red-500'
    case 'ANOMALOUS': return 'bg-purple-500'
    case 'UNKNOWN': return 'bg-zinc-600'
  }
}

export function signalQualityLabel(quality: SignalQuality): string {
  switch (quality) {
    case 'CLEAN': return 'LIMPIA'
    case 'NOISY': return 'RUIDOSA'
    case 'DEGRADED': return 'DEGRADADA'
    case 'UNRELIABLE': return 'NO CONFIABLE'
  }
}

export function signalQualityColor(quality: SignalQuality): string {
  switch (quality) {
    case 'CLEAN': return 'text-emerald-400'
    case 'NOISY': return 'text-amber-400'
    case 'DEGRADED': return 'text-orange-400'
    case 'UNRELIABLE': return 'text-red-400'
  }
}

export function confidenceTierLabel(tier: ConfidenceTier): string {
  switch (tier) {
    case 'reliable': return 'CONFIABLE'
    case 'uncertain': return 'INCERTO'
    case 'noisy': return 'RUIDOSO'
    case 'invalid': return 'INVÁLIDO'
  }
}

export function confidenceTierColor(tier: ConfidenceTier): string {
  switch (tier) {
    case 'reliable': return 'text-emerald-400'
    case 'uncertain': return 'text-amber-400'
    case 'noisy': return 'text-orange-400'
    case 'invalid': return 'text-red-400'
  }
}

// Mini Kalman-lite for simple smoothing (user's bonus function)
export function smooth(prev: number, curr: number, alpha = 0.2): number {
  return prev + (curr - prev) * alpha
}

// ── V3.1 DISPLAY HELPERS ──

export function uncertaintyLabel(radiusM: number): string {
  if (radiusM <= 15) return 'ALTA'
  if (radiusM <= 50) return 'BUENA'
  if (radiusM <= 100) return 'MODERADA'
  if (radiusM <= 300) return 'BAJA'
  return 'MUY BAJA'
}

export function uncertaintyColor(radiusM: number): string {
  if (radiusM <= 15) return 'text-emerald-400'
  if (radiusM <= 50) return 'text-emerald-400'
  if (radiusM <= 100) return 'text-amber-400'
  if (radiusM <= 300) return 'text-orange-400'
  return 'text-red-400'
}

export function estimateLabel(isEstimate: boolean): string {
  return isEstimate ? 'ESTIMADA' : 'CONFIRMADA'
}

export function estimateColor(isEstimate: boolean): string {
  return isEstimate ? 'text-amber-400' : 'text-emerald-400'
}
