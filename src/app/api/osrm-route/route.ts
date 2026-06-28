import { NextRequest, NextResponse } from 'next/server'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

// ══════════════════════════════════════════════════════════════════
// OSRM ROUTING PROXY — Road-aligned ghost trail routing
// ══════════════════════════════════════════════════════════════════
//
// Accepts: GET /api/osrm-route?coords=lng,lat;lng,lat;lng,lat
// Returns: { points: [lat, lng][], distance_m, duration_s } or { points: [], error }
//
// Uses public OSRM demo server. Falls back to straight line on failure.
// ══════════════════════════════════════════════════════════════════

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving'

interface RouteResult {
  points: [number, number][]
  distance_m: number
  duration_s: number
  routed: boolean
}

function straightLineFallback(coords: [number, number][]): RouteResult {
  return { points: coords, distance_m: 0, duration_s: 0, routed: false }
}

export async function GET(request: NextRequest) {
  const coordsParam = request.nextUrl.searchParams.get('coords')

  if (!coordsParam) {
    return NextResponse.json({ error: 'Missing coords param', points: [], routed: false }, { status: 400 })
  }

  // Parse "lng,lat;lng,lat;..." format
  const pairs = coordsParam.split(';')
  if (pairs.length < 2) {
    return NextResponse.json({ error: 'Need at least 2 points', points: [], routed: false }, { status: 400 })
  }

  const parsed: [number, number][] = []
  for (const pair of pairs) {
    const [lngStr, latStr] = pair.split(',')
    const lng = parseFloat(lngStr)
    const lat = parseFloat(latStr)
    if (!isFinite(lng) || !isFinite(lat)) {
      return NextResponse.json({ error: 'Invalid coordinate', points: [], routed: false }, { status: 400 })
    }
    parsed.push([lat, lng]) // Store as [lat, lng] for Leaflet
  }

  // If only 2 points very close together (<20m), skip routing
  if (parsed.length === 2) {
    const dLat = parsed[1][0] - parsed[0][0]
    const dLng = parsed[1][1] - parsed[0][1]
    const distM = Math.sqrt(dLat * dLat * 111000 * 111000 + dLng * dLng * 85000 * 85000)
    if (distM < 20) {
      return NextResponse.json({ points: parsed, distance_m: distM, duration_s: 0, routed: false })
    }
  }

  try {
    // OSRM expects lng,lat;lng,lat format in URL
    const osrmUrl = `${OSRM_BASE}/${coordsParam}?overview=full&geometries=geojson`

    const resp = await fetch(osrmUrl, {
      cache: 'no-store',
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000),
    })

    if (!resp.ok) {
      console.warn(`[osrm-route] OSRM returned ${resp.status}, falling back to straight line`)
      return NextResponse.json(straightLineFallback(parsed))
    }

    const data = await resp.json()

    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      console.warn('[osrm-route] OSRM no routes found, falling back to straight line')
      return NextResponse.json(straightLineFallback(parsed))
    }

    const route = data.routes[0]
    const geometry = route.geometry

    if (!geometry || !geometry.coordinates) {
      return NextResponse.json(straightLineFallback(parsed))
    }

    // Convert GeoJSON [lng, lat] to Leaflet [lat, lng]
    const points: [number, number][] = geometry.coordinates.map(
      (coord: number[]) => [coord[1], coord[0]] as [number, number]
    )

    return NextResponse.json({
      points,
      distance_m: route.distance || 0,
      duration_s: route.duration || 0,
      routed: true,
    })
  } catch (err) {
    console.warn('[osrm-route] OSRM error, falling back to straight line:', err)
    return NextResponse.json(straightLineFallback(parsed))
  }
}
