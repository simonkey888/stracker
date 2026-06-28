import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

const PYTHON_BACKEND_PORT = 3003
const PRODUCTION_BACKEND = 'https://strackerglm.onrender.com'

// GHOSTRAIL_V7: Strict 24h filter. Discard any point without valid timestamp.
const GHOSTRAIL_24H_MS = 24 * 60 * 60 * 1000

// Zone classification (mirrors Python _classify_zone)
const HOME_LAT = -31.64693
const HOME_LNG = -60.71598
const HOME_RADIUS_M = 150
const WORK_LAT = -31.6366
const WORK_LNG = -60.7012
const WORK_RADIUS_M = 150

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function classifyZone(lat: number, lng: number, speed: number): string {
  if (haversineM(lat, lng, HOME_LAT, HOME_LNG) <= HOME_RADIUS_M) return 'Casa'
  if (haversineM(lat, lng, WORK_LAT, WORK_LNG) <= WORK_RADIUS_M) return 'Trabajo'
  if (speed > 3) return 'En ruta'
  return 'Otro'
}

interface GhostrailPoint {
  lat: number
  lng: number
  zone?: string
  t?: string
}

function filterGhostrail24h(pts: GhostrailPoint[]): GhostrailPoint[] {
  const now = Date.now()
  const cutoff = now - GHOSTRAIL_24H_MS
  return pts.filter(p => {
    if (p.lat == null || p.lng == null || !isFinite(p.lat) || !isFinite(p.lng)) return false
    if (!p.t) return false // V7: no timestamp = discard
    const ts = new Date(p.t).getTime()
    if (!isFinite(ts)) return false // invalid timestamp = discard
    if (ts < cutoff) return false // older than 24h = discard
    return true
  })
}

// V7 COMPAT: If backend ghostrail has no timestamps, rebuild from CSV points
// which always have timestamps. This handles the case where production
// hasn't been updated yet with the V7 backend.
function rebuildGhostrailFromCsvPoints(csvPoints: any[]): GhostrailPoint[] {
  const now = Date.now()
  const cutoff = now - GHOSTRAIL_24H_MS
  const result: GhostrailPoint[] = []
  for (const p of csvPoints) {
    const lat = p.lat ?? p.latitude
    const lng = p.lng ?? p.longitude
    if (lat == null || lng == null || !isFinite(lat) || !isFinite(lng)) continue
    const ts = p.timestamp || p.ts
    if (!ts) continue
    const tsMs = new Date(ts).getTime()
    if (!isFinite(tsMs) || tsMs < cutoff) continue
    const speed = parseFloat(p.speed_kmh) || 0
    const zone = classifyZone(lat, lng, speed)
    result.push({ lat, lng, zone, t: ts })
  }
  return result
}

export async function GET() {
  try {
    // Try local Python tracker first
    try {
      const trackerUrl = `http://127.0.0.1:${PYTHON_BACKEND_PORT}/points`
      const trackerResp = await fetch(trackerUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3000),
      })
      if (trackerResp.ok) {
        const data = await trackerResp.json()
        return NextResponse.json(transformData(data))
      }
    } catch { /* local backend not available */ }

    // Try local kernel service
    try {
      const kernelUrl = `http://127.0.0.1:${PYTHON_BACKEND_PORT}/snapshot`
      const kernelResp = await fetch(kernelUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(2000),
      })
      if (kernelResp.ok) {
        const data = await kernelResp.json()
        return NextResponse.json(data)
      }
    } catch { /* kernel not available */ }

    // Fallback: fetch from production Python tracker
    try {
      const prodUrl = `${PRODUCTION_BACKEND}/points`
      const prodResp = await fetch(prodUrl, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      })
      if (prodResp.ok) {
        const data = await prodResp.json()
        return NextResponse.json(transformData(data))
      }
    } catch { /* production backend not available */ }

    return NextResponse.json(
      { error: 'All backends unavailable', source: 'multi_fallback', state: null, points: [], ghostrail_pts: [] },
      { status: 503 }
    )
  } catch (error) {
    return NextResponse.json(
      { error: 'Service error', details: String(error), source: 'multi_fallback', state: null, points: [], ghostrail_pts: [] },
      { status: 503 }
    )
  }
}

function transformData(data: any) {
  // V7: Primary source = state.ghostrail.points_24h (from CSV rebuild if backend is V7)
  // Fallback: data.ghostrail_pts top-level (legacy compat)
  const ghostrailFromState: GhostrailPoint[] = data.state?.ghostrail?.points_24h || []
  const ghostrailFromTopLevel: GhostrailPoint[] = data.ghostrail_pts || []
  const rawPts = ghostrailFromState.length > 0 ? ghostrailFromState : ghostrailFromTopLevel

  // V7: Apply strict 24h filter — discard points without timestamp
  let ghostrailPts = filterGhostrail24h(rawPts)

  // V7 COMPAT: If all ghostrail points were discarded (no timestamps from old backend),
  // rebuild from CSV points which always have timestamps.
  if (ghostrailPts.length === 0 && rawPts.length > 0) {
    const csvPoints = data.points || []
    if (csvPoints.length > 0) {
      ghostrailPts = rebuildGhostrailFromCsvPoints(csvPoints)
      console.log(`[api/points] V7 COMPAT: rebuilt ${ghostrailPts.length} ghostrail pts from CSV (backend had no timestamps)`)
    }
  }

  console.log(`[api/points] V7: state=${ghostrailFromState.length} top=${ghostrailFromTopLevel.length} final=${ghostrailPts.length}`)

  return {
    points: data.points || [],
    state: data.state || null,
    ghostrail_pts: ghostrailPts,
    _meta: {
      tick: 0,
      event_seq: 0,
      snapshot_version: 1,
      architecture: 'PYTHON_TRACKER_BACKEND',
    },
  }
}
