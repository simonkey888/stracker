import { NextRequest, NextResponse } from 'next/server'
import axios from 'axios'

// ════════════════════════════════════════════════════════════════
// GOOGLE MAPS LINK PARSER — FULL PIPELINE
// ════════════════════════════════════════════════════════════════
//
// Pipeline:
//   1. Expand URL corta (redirect chain)
//   2. Detectar si hay coords en HTML o URL final
//   3. Extraer lat/lng (regex + HTML fallback)
//   4. Calcular confidence_score
//   5. Emitir sighting event (opcional, con ?emit=true)
//
// Confidence scoring:
//   +0.60 si hay lat/lng en URL
//   +0.20 si redirect estable (1-2 hops, no loop)
//   +0.10 si patrón Google Maps válido
//   +0.10 si repetición histórica del mismo dominio
//   -0.40 si no hay coords
//   -0.30 si URL cambiante / sesión corta
//   -0.50 si request falló o timeout
// ════════════════════════════════════════════════════════════════

interface ParseResult {
  event_type: 'geo_share'
  source: 'google_maps'
  url_original: string
  url_final: string | null
  lat: number | null
  lng: number | null
  confidence_score: number
  risk_flags: string[]
  metadata: {
    raw_input: string
    redirect_chain: string[]
    extraction_method: string
    response_status: number | null
    response_time_ms: number
    place_name: string | null
  }
}

const GOOGLE_MAPS_PATTERNS = [
  // @lat,lng pattern in URL
  /@(-?\d+\.\d+),(-?\d+\.\d+)/,
  // !3dlat!4dlng pattern (Google Maps embed)
  /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,
  // /place/Name/@lat,lng
  /\/@(-?\d+\.\d+),(-?\d+\.\d+)/,
  // ?q=lat,lng
  /[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/,
  // ?center=lat,lng
  /[?&]center=(-?\d+\.\d+),(-?\d+\.\d+)/,
  // /search/lat,lng
  /\/search\/(-?\d+\.\d+),(-?\d+\.\d+)/,
  // data=!3m1!4b1!4m5!3m4!1s0x...!2dLNG!3dLAT
  /!3d(-?\d+\.\d+).*!2d(-?\d+\.\d+)/,
  // dir/lat,lng
  /dir\/(-?\d+\.\d+),(-?\d+\.\d+)/,
]

const HTML_COORD_PATTERNS = [
  // meta og:url with coords
  /content="[^"]*@(-?\d+\.\d+),(-?\d+\.\d+)"/,
  // JSON in page with coords
  /\["(-?\d+\.\d+)"\s*,\s*"(-?\d+\.\d+)"\]/,
  // Generic lat/lng JSON
  /"lat"\s*:\s*(-?\d+\.\d+).*?"lng"\s*:\s*(-?\d+\.\d+)/,
  // center with lat lng object
  /center":\{?\s*"lat":\s*(-?\d+\.\d+).*?"lng":\s*(-?\d+\.\d+)/,
]

function extractCoordsFromUrl(url: string): { lat: number; lng: number; method: string } | null {
  for (const pattern of GOOGLE_MAPS_PATTERNS) {
    const match = url.match(pattern)
    if (match) {
      const lat = parseFloat(match[1])
      const lng = parseFloat(match[2])
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng, method: 'url_regex' }
      }
    }
  }
  return null
}

function extractCoordsFromHtml(html: string): { lat: number; lng: number; method: string } | null {
  for (const pattern of HTML_COORD_PATTERNS) {
    const match = html.match(pattern)
    if (match) {
      const lat = parseFloat(match[1])
      const lng = parseFloat(match[2])
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        return { lat, lng, method: 'html_regex' }
      }
    }
  }
  return null
}

function extractPlaceName(url: string): string | null {
  const placeMatch = url.match(/\/place\/([^/@]+)/)
  if (placeMatch) {
    return decodeURIComponent(placeMatch[1].replace(/\+/g, ' '))
  }
  return null
}

function calculateConfidence(params: {
  hasCoords: boolean
  extractionMethod: string
  redirectStable: boolean
  isGoogleMapsPattern: boolean
  hasHistoricalDomain: boolean
  errorOccurred: boolean
  urlChanging: boolean
}): number {
  let score = 0

  // Positive signals
  if (params.hasCoords) score += 0.60
  if (params.redirectStable) score += 0.20
  if (params.isGoogleMapsPattern) score += 0.10
  if (params.hasHistoricalDomain) score += 0.10

  // Negative signals
  if (!params.hasCoords) score -= 0.40
  if (params.urlChanging) score -= 0.30
  if (params.errorOccurred) score -= 0.50

  // Method bonus/penalty
  if (params.extractionMethod === 'html_regex') score -= 0.10
  if (params.extractionMethod === 'url_regex') score += 0.05

  return Math.max(0, Math.min(1, Math.round(score * 100) / 100))
}

function assessRiskFlags(params: {
  hasCoords: boolean
  confidence: number
  redirectHops: number
  extractionMethod: string
  errorOccurred: boolean
}): string[] {
  const flags: string[] = []

  if (!params.hasCoords) flags.push('no_coords_extracted')
  if (params.confidence < 0.3) flags.push('low_confidence')
  if (params.redirectHops > 3) flags.push('excessive_redirects')
  if (params.extractionMethod === 'html_regex') flags.push('html_extraction_unstable')
  if (params.errorOccurred) flags.push('request_failed')
  if (params.confidence >= 0.8) flags.push('high_confidence')

  return flags
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { url, entityId, emit } = body

  if (!url) {
    return NextResponse.json({ error: 'url required' }, { status: 400 })
  }

  const startTime = Date.now()
  const result: ParseResult = {
    event_type: 'geo_share',
    source: 'google_maps',
    url_original: url,
    url_final: null,
    lat: null,
    lng: null,
    confidence_score: 0,
    risk_flags: [],
    metadata: {
      raw_input: url,
      redirect_chain: [],
      extraction_method: 'none',
      response_status: null,
      response_time_ms: 0,
      place_name: null,
    },
  }

  let errorOccurred = false
  let redirectStable = true
  let urlChanging = false
  let isGoogleMapsPattern = false
  let hasHistoricalDomain = false

  try {
    // ── STEP 1: Expand short URL (follow redirects) ──
    const axiosRes = await axios.get(url, {
      maxRedirects: 5,
      timeout: 10000,
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
      },
    })

    const finalUrl = axiosRes.request?.res?.responseUrl || url
    const statusCode = axiosRes.status
    const html: string = typeof axiosRes.data === 'string' ? axiosRes.data : JSON.stringify(axiosRes.data)

    result.url_final = finalUrl
    result.metadata.response_status = statusCode

    // Track redirect chain
    const redirectChain: string[] = [url]
    if (finalUrl !== url) {
      redirectChain.push(finalUrl)
    }
    result.metadata.redirect_chain = redirectChain.filter(Boolean)

    // Check redirect stability
    const redirectHops = result.metadata.redirect_chain.length - 1
    if (redirectHops > 2) redirectStable = false
    if (redirectHops > 3) urlChanging = true

    // Check if Google Maps pattern
    isGoogleMapsPattern = /google\.(com|co\.uk|com?\.ar|es|mx|cl|pe|com\.br|co)\/maps/.test(finalUrl) ||
                          /maps\.google/.test(finalUrl) ||
                          /goo\.gl\/maps/.test(url) ||
                          /maps\.app\.goo\.gl/.test(url)

    // ── STEP 2 & 3: Extract coordinates ──
    // Try URL first (most reliable)
    let coords = extractCoordsFromUrl(finalUrl)

    if (coords) {
      result.lat = coords.lat
      result.lng = coords.lng
      result.metadata.extraction_method = coords.method
    } else {
      // Fallback: try original URL
      coords = extractCoordsFromUrl(url)
      if (coords) {
        result.lat = coords.lat
        result.lng = coords.lng
        result.metadata.extraction_method = 'original_url_regex'
      }
    }

    // Fallback: try HTML body
    if (!coords && html) {
      coords = extractCoordsFromHtml(html)
      if (coords) {
        result.lat = coords.lat
        result.lng = coords.lng
        result.metadata.extraction_method = coords.method
      }
    }

    // Extract place name
    result.metadata.place_name = extractPlaceName(finalUrl) || extractPlaceName(url)

    // ── STEP 4: Calculate confidence score ──
    // Historical domain check disabled — scoring now lives in /api/ingest
    hasHistoricalDomain = isGoogleMapsPattern

    const confidence = calculateConfidence({
      hasCoords: result.lat !== null && result.lng !== null,
      extractionMethod: result.metadata.extraction_method,
      redirectStable,
      isGoogleMapsPattern,
      hasHistoricalDomain,
      errorOccurred,
      urlChanging,
    })

    result.confidence_score = confidence
    result.risk_flags = assessRiskFlags({
      hasCoords: result.lat !== null && result.lng !== null,
      confidence,
      redirectHops,
      extractionMethod: result.metadata.extraction_method,
      errorOccurred,
    })

  } catch (err: any) {
    errorOccurred = true
    result.url_final = null
    result.metadata.extraction_method = 'error'
    result.confidence_score = 0
    result.risk_flags = ['request_failed', 'no_coords_extracted', 'low_confidence']

    if (err.code === 'ECONNABORTED') {
      result.risk_flags.push('timeout')
    }
  }

  result.metadata.response_time_ms = Date.now() - startTime

  // ── STEP 5: NOTE — Emit is now handled by /api/ingest ──
  // parse-link only extracts coords. The client (UI or Chrome Extension)
  // sends the clean signal to /api/ingest which handles validation,
  // scoring, storage, and alert checks.
  // This endpoint is a FALLBACK for full URLs that work server-side.
  // Short links (maps.app.goo.gl) are resolved by the Chrome Extension.
  const sightingResult = null

  return NextResponse.json({
    ...result,
    sighting: null,
  })
}
