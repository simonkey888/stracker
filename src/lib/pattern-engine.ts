/**
 * INTEL_02 (stracker_v5.4_intelligence): Behavioral Pattern Recognition.
 *
 * Lightweight spatial-density clustering (simplified k-means) over the last
 * 7 days of ghostrail points. No Big Data — just enough to answer:
 *   "Where does the target usually spend time, and when?"
 *
 * Visit model (per engineer note): a point series that stays within ±50m for
 * >60 min counts as one "visit" to that centroid.
 *
 * Outputs:
 *  - TOP_3_SPOTS: the 3 centroids with the most total dwell time, labeled
 *    by proximity to known geofences (HOME/WORK) or "Spot N".
 *  - SCHEDULE_ANALYSIS: for each spot, the set of hour-of-day buckets in
 *    which it is typically occupied (modal hours).
 *  - ANOMALY_DETECTION: true if the current point falls inside a known
 *    spot's centroid BUT outside that spot's habitual hour windows
 *    (i.e. "the target is at a usual place at an unusual time").
 */

import type { GhostPoint } from '@/components/tracker/AnalyticsPanel'

export interface KnownSpot {
  lat: number
  lng: number
  label: string
  totalDwellMin: number
  visitCount: number
  /** Hour-of-day buckets (0-23) where this spot is typically occupied. */
  habitualHours: number[]
}

export interface PatternResult {
  spots: KnownSpot[] // TOP_3, sorted by dwell desc
  anomaly: {
    detected: boolean
    reason: string
    spotIndex?: number
  }
}

const VISIT_RADIUS_M = 50
const VISIT_MIN_DWELL_MS = 60 * 60 * 1000 // 60 min
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** Simplified k-means: seeds = first points, assign by radius, recompute
 *  centroid as the mean of assigned points. One pass is enough for the
 *  coarse clustering we need. */
function clusterVisits(
  pts: { lat: number; lng: number; t: number }[],
): { lat: number; lng: number; pts: { lat: number; lng: number; t: number }[] }[] {
  if (pts.length === 0) return []
  // Step 1: greedy clustering — a new point joins the nearest existing cluster
  // within VISIT_RADIUS_M, else starts a new cluster.
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
      // recompute centroid incrementally
      const c = clusters[best]
      c.lat = c.pts.reduce((s, x) => s + x.lat, 0) / c.pts.length
      c.lng = c.pts.reduce((s, x) => s + x.lng, 0) / c.pts.length
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, pts: [p] })
    }
  }
  return clusters
}

function dwellMs(c: { pts: { t: number }[] }): number {
  if (c.pts.length < 2) return 0
  const ts = c.pts.map(p => p.t).sort((a, b) => a - b)
  return ts[ts.length - 1] - ts[0]
}

function labelSpot(
  lat: number,
  lng: number,
  known: { home?: { lat: number; lng: number; radiusM: number }; work?: { lat: number; lng: number; radiusM: number } },
  idx: number,
): string {
  if (known.home && haversineM(lat, lng, known.home.lat, known.home.lng) < known.home.radiusM) return 'Casa'
  if (known.work && haversineM(lat, lng, known.work.lat, known.work.lng) < known.work.radiusM) return 'Trabajo'
  return `Spot ${idx + 1}`
}

/** Modal hours: returns the hour buckets (0-23) that account for the top ~50%
 *  of presence at this spot. Cheap histogram approach. */
function habitualHoursFor(tses: number[]): number[] {
  const buckets = new Array(24).fill(0)
  for (const t of tses) {
    const h = new Date(t).getHours()
    buckets[h]++
  }
  const total = buckets.reduce((s, n) => s + n, 0) || 1
  // hours whose share ≥ 8% of presence (covers 3-4 peak hours typically)
  return buckets
    .map((n, h) => ({ h, share: n / total }))
    .filter(x => x.share >= 0.08)
    .map(x => x.h)
    .sort((a, b) => a - b)
}

function formatHourRange(hours: number[]): string {
  if (hours.length === 0) return '—'
  // Collapse consecutive hours into ranges, e.g. [9,10,11,18,19] → "9-12, 18-20"
  const ranges: string[] = []
  let start = hours[0]
  let prev = hours[0]
  for (let i = 1; i < hours.length; i++) {
    if (hours[i] === prev + 1) { prev = hours[i]; continue }
    ranges.push(start === prev ? `${start}h` : `${start}-${prev + 1}h`)
    start = hours[i]
    prev = hours[i]
  }
  ranges.push(start === prev ? `${start}h` : `${start}-${prev + 1}h`)
  return ranges.join(', ')
}

export { formatHourRange }

/**
 * Runs the full pattern analysis.
 *
 * @param ghostrailPts  raw points (lat, lng, t ISO string)
 * @param current       current position (null if unknown)
 * @param known         known geofences for labeling
 */
export function analyzePatterns(
  ghostrailPts: GhostPoint[],
  current: { lat: number; lng: number } | null,
  known: { home?: { lat: number; lng: number; radiusM: number }; work?: { lat: number; lng: number; radiusM: number } },
): PatternResult {
  const now = Date.now()
  // Filter to last 7d + parse timestamps + sort ascending.
  const pts = ghostrailPts
    .filter(p => p.t && now - new Date(p.t).getTime() <= SEVEN_DAYS_MS)
    .map(p => ({ lat: p.lat, lng: p.lng, t: new Date(p.t!).getTime() }))
    .filter(p => !isNaN(p.t))
    .sort((a, b) => a.t - b.t)

  const clusters = clusterVisits(pts)
    .map(c => ({ ...c, dwell: dwellMs(c) }))
    .filter(c => c.dwell >= VISIT_MIN_DWELL_MS) // ≥60 min visits only
    .sort((a, b) => b.dwell - a.dwell)

  const top = clusters.slice(0, 3)
  const spots: KnownSpot[] = top.map((c, i) => ({
    lat: c.lat,
    lng: c.lng,
    label: labelSpot(c.lat, c.lng, known, i),
    totalDwellMin: Math.round(c.dwell / 60000),
    visitCount: 1, // each cluster = one merged visit region
    habitualHours: habitualHoursFor(c.pts.map(p => p.t)),
  }))

  // ── ANOMALY_DETECTION: current is inside a known spot but outside its
  //    habitual hour windows. ──
  let anomaly: PatternResult['anomaly'] = { detected: false, reason: 'Sin datos suficientes' }
  if (current && spots.length > 0) {
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]
      if (haversineM(current.lat, current.lng, s.lat, s.lng) < VISIT_RADIUS_M) {
        const curHour = new Date().getHours()
        if (s.habitualHours.length > 0 && !s.habitualHours.includes(curHour)) {
          anomaly = {
            detected: true,
            reason: `${s.label} a las ${curHour}h (fuera del horario habitual)`,
            spotIndex: i,
          }
          break
        }
      }
    }
  }

  return { spots, anomaly }
}
