/**
 * PREDICT_ENGINE_MARKOV — stracker_v5.8_pro_fortress
 *
 * First-Order Markov Chain model over detected hotspots.
 *
 * Builds a transition matrix: P(Destination | Origin, HourBucket)
 *
 * Given the target's current hotspot + the current hour, the engine
 * calculates the probability distribution over likely next destinations.
 *
 * Example:
 *   "If the target leaves 'Casa' at 08:00, what's the probability of
 *    going to 'Trabajo' vs 'Gimnasio' vs 'Spot 3'?"
 *
 * The model is pure statistics — no neural networks, no massive compute.
 * It's a transition count matrix normalized into probabilities, bucketed
 * by hour-of-day (6 buckets of 4 hours each for smoothing).
 *
 * UI Integration:
 *   predictNext() returns the top-3 most likely destinations with their
 *   probabilities. The AnalyticsPanel PatternsView renders a "Predicción"
 *   badge with a probability bar for the #1 candidate.
 */

import type { GhostPoint } from '@/components/tracker/AnalyticsPanel'

// ── Constants ──
const VISIT_RADIUS_M = 50
const MIN_TRANSITIONS = 2 // Need at least 2 transitions to make a prediction
const HOUR_BUCKET_SIZE = 4 // 4-hour buckets → 6 buckets per day
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const TRANSITION_WINDOW_MS = 60 * 60 * 1000 // Max time between leaving origin and arriving at dest (1h)

export interface Hotspot {
  id: number
  lat: number
  lng: number
  label: string
  totalDwellMin: number
  visitCount: number
}

export interface Prediction {
  /** Label of the predicted destination (e.g. "Trabajo"). */
  label: string
  /** Probability 0-1 (e.g. 0.85 = 85%). */
  probability: number
  /** Hotspot ID of the predicted destination. */
  hotspotId: number
}

export interface PredictionResult {
  /** Whether a prediction could be made (false if insufficient data). */
  available: boolean
  /** The current hotspot the target is at (null if not at any known hotspot). */
  currentSpot: Hotspot | null
  /** Top-3 predictions sorted by probability descending. */
  predictions: Prediction[]
  /** Reason if prediction is unavailable. */
  reason?: string
}

/**
 * Hour bucket: 0=00-04h, 1=04-08h, 2=08-12h, 3=12-16h, 4=16-20h, 5=20-24h
 */
function hourBucket(hour: number): number {
  return Math.floor(hour / HOUR_BUCKET_SIZE)
}

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/**
 * Detect hotspots by clustering ghostrail points.
 * Reuses the same greedy radius-based clustering as pattern-engine.
 * Only clusters with ≥60min total dwell time are considered hotspots.
 */
function detectHotspots(
  pts: { lat: number; lng: number; t: number }[],
  known: { home?: { lat: number; lng: number; radiusM: number }; work?: { lat: number; lng: number; radiusM: number } },
): Hotspot[] {
  if (pts.length === 0) return []

  // Greedy clustering — same as pattern-engine
  const clusters: { lat: number; lng: number; pts: { lat: number; lng: number; t: number }[] }[] = []
  for (const p of pts) {
    let best = -1
    let bestDist = Infinity
    for (let i = 0; i < clusters.length; i++) {
      const d = haversineM(p.lat, p.lng, clusters[i].lat, clusters[i].lng)
      if (d < VISIT_RADIUS_M && d < bestDist) { bestDist = d; best = i }
    }
    if (best >= 0) {
      clusters[best].pts.push(p)
      const c = clusters[best]
      c.lat = c.pts.reduce((s, x) => s + x.lat, 0) / c.pts.length
      c.lng = c.pts.reduce((s, x) => s + x.lng, 0) / c.pts.length
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, pts: [p] })
    }
  }

  // Filter: ≥60min dwell time
  const hotspots: Hotspot[] = []
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]
    const ts = c.pts.map(p => p.t).sort((a, b) => a - b)
    const dwell = ts.length >= 2 ? ts[ts.length - 1] - ts[0] : 0
    if (dwell < 60 * 60 * 1000) continue

    let label = `Spot ${hotspots.length + 1}`
    if (known.home && haversineM(c.lat, c.lng, known.home.lat, known.home.lng) < known.home.radiusM) {
      label = 'Casa'
    } else if (known.work && haversineM(c.lat, c.lng, known.work.lat, known.work.lng) < known.work.radiusM) {
      label = 'Trabajo'
    }

    hotspots.push({
      id: i,
      lat: c.lat,
      lng: c.lng,
      label,
      totalDwellMin: Math.round(dwell / 60000),
      visitCount: 1,
    })
  }

  return hotspots
}

/**
 * Find which hotspot a point belongs to (null if none).
 */
function findHotspot(
  lat: number,
  lng: number,
  hotspots: Hotspot[],
): Hotspot | null {
  for (const h of hotspots) {
    if (haversineM(lat, lng, h.lat, h.lng) < VISIT_RADIUS_M) {
      return h
    }
  }
  return null
}

/**
 * Build the transition matrix by walking the chronological point sequence.
 *
 * A "transition" is recorded when:
 *   1. The target was at hotspot A (origin)
 *   2. The target left A and arrived at hotspot B (destination)
 *   3. The time between leaving A and arriving at B is ≤ TRANSITION_WINDOW_MS
 *
 * The matrix is keyed by (originId, hourBucket) → Map<destId, count>.
 *
 * Returns a nested Map for efficient lookup.
 */
function buildTransitionMatrix(
  pts: { lat: number; lng: number; t: number }[],
  hotspots: Hotspot[],
): Map<string, Map<number, number>> {
  // matrix key: `${originId}:${hourBucket}` → Map<destId, count>
  const matrix = new Map<string, Map<number, number>>()

  if (pts.length < 2 || hotspots.length === 0) return matrix

  // Sort by timestamp ascending
  const sorted = [...pts].sort((a, b) => a.t - b.t)

  let currentOrigin: Hotspot | null = null
  let leftOriginAt: number | null = null
  let originHourBucket: number = 0

  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i]
    const spot = findHotspot(p.lat, p.lng, hotspots)

    if (spot) {
      if (currentOrigin === null) {
        // Arrived at a hotspot — mark as potential origin
        currentOrigin = spot
        leftOriginAt = null
        originHourBucket = hourBucket(new Date(p.t).getHours())
      } else if (currentOrigin.id === spot.id) {
        // Still at the same hotspot — no transition
        leftOriginAt = null
      } else {
        // Arrived at a DIFFERENT hotspot — transition!
        if (leftOriginAt != null) {
          const transitionMs = p.t - leftOriginAt
          if (transitionMs <= TRANSITION_WINDOW_MS) {
            const key = `${currentOrigin.id}:${originHourBucket}`
            const dests = matrix.get(key) || new Map<number, number>()
            dests.set(spot.id, (dests.get(spot.id) || 0) + 1)
            matrix.set(key, dests)
          }
        }
        // New origin
        currentOrigin = spot
        leftOriginAt = null
        originHourBucket = hourBucket(new Date(p.t).getHours())
      }
    } else {
      // Not at any hotspot — if we were at one, mark the departure time
      if (currentOrigin != null && leftOriginAt === null) {
        leftOriginAt = p.t
      }
    }
  }

  return matrix
}

/**
 * Predict the next destination given the current hotspot + hour.
 *
 * Looks up the transition matrix at key `${currentSpotId}:${hourBucket}`
 * and normalizes the counts into probabilities.
 *
 * Returns the top-3 predictions sorted by probability descending.
 */
export function predictNext(
  ghostrailPts: GhostPoint[],
  currentLat: number | null,
  currentLng: number | null,
  known: { home?: { lat: number; lng: number; radiusM: number }; work?: { lat: number; lng: number; radiusM: number } },
): PredictionResult {
  const now = Date.now()

  // Filter to last 7d + parse timestamps + sort
  const pts = ghostrailPts
    .filter(p => p.t && now - new Date(p.t).getTime() <= SEVEN_DAYS_MS)
    .map(p => ({ lat: p.lat, lng: p.lng, t: new Date(p.t!).getTime() }))
    .filter(p => !isNaN(p.t))
    .sort((a, b) => a.t - b.t)

  if (pts.length < 4) {
    return { available: false, currentSpot: null, predictions: [], reason: 'Sin datos suficientes (mín. 4 puntos)' }
  }

  // 1. Detect hotspots
  const hotspots = detectHotspots(pts, known)
  if (hotspots.length < 2) {
    return { available: false, currentSpot: null, predictions: [], reason: 'Necesita ≥2 hotspots detectados' }
  }

  // 2. Find current hotspot
  let currentSpot: Hotspot | null = null
  if (currentLat != null && currentLng != null) {
    currentSpot = findHotspot(currentLat, currentLng, hotspots)
  }

  if (!currentSpot) {
    return { available: false, currentSpot: null, predictions: [], reason: 'No está en un hotspot conocido' }
  }

  // 3. Build transition matrix
  const matrix = buildTransitionMatrix(pts, hotspots)

  // 4. Look up predictions for current spot + hour
  const currentHourBucket = hourBucket(new Date().getHours())
  const key = `${currentSpot.id}:${currentHourBucket}`
  const destCounts = matrix.get(key)

  if (!destCounts || destCounts.size === 0) {
    // Try adjacent hour buckets for smoothing
    const prevBucket = (currentHourBucket + 5) % 6 // -1 mod 6
    const nextBucket = (currentHourBucket + 1) % 6
    const prevCounts = matrix.get(`${currentSpot.id}:${prevBucket}`)
    const nextCounts = matrix.get(`${currentSpot.id}:${nextBucket}`)
    const merged = new Map<number, number>()
    for (const [id, c] of (prevCounts || [])) merged.set(id, (merged.get(id) || 0) + c * 0.5)
    for (const [id, c] of (nextCounts || [])) merged.set(id, (merged.get(id) || 0) + c * 0.5)
    if (merged.size === 0) {
      return { available: false, currentSpot, predictions: [], reason: 'Sin transiciones registradas en esta franja horaria' }
    }
    return normalizePredictions(merged, hotspots, currentSpot)
  }

  return normalizePredictions(destCounts, hotspots, currentSpot)
}

function normalizePredictions(
  destCounts: Map<number, number>,
  hotspots: Hotspot[],
  currentSpot: Hotspot,
): PredictionResult {
  const total = Array.from(destCounts.values()).reduce((s, c) => s + c, 0)
  if (total < MIN_TRANSITIONS) {
    return { available: false, currentSpot, predictions: [], reason: `Solo ${total} transición(es) — necesita ≥${MIN_TRANSITIONS}` }
  }

  const predictions: Prediction[] = []
  for (const [destId, count] of destCounts) {
    const hotspot = hotspots.find(h => h.id === destId)
    if (!hotspot) continue
    predictions.push({
      label: hotspot.label,
      probability: count / total,
      hotspotId: destId,
    })
  }

  predictions.sort((a, b) => b.probability - a.probability)

  return {
    available: predictions.length > 0,
    currentSpot,
    predictions: predictions.slice(0, 3),
  }
}

/**
 * Format a probability as a percentage string (e.g. 0.85 → "85%").
 */
export function formatProbability(p: number): string {
  return `${Math.round(p * 100)}%`
}
