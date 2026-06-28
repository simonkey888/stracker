import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { checkAlertZones } from '@/lib/alert-zones'
import {
  KalmanFilter,
  runSignalPipeline,
  type RawSignal,
  type HistoricalPoint,
  type SignalPipelineResult,
} from '@/lib/signal-pipeline'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

// ── CORS HEADERS — Chrome Extension needs these ──
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

// ════════════════════════════════════════════════════════════════
// V3 SIGNAL INGESTION PIPELINE
// ════════════════════════════════════════════════════════════════
//
// GPS → Validate → Filter (Kalman) → Classify → Score → Store → Alert
//
// Every sighting now carries:
//   - RAW signal: lat, lng (what the client sent)
//   - FILTERED signal: filteredLat, filteredLng (Kalman-smoothed)
//   - CLASSIFIED signal: movementState, heading
//   - DERIVED signal: confidence, signalQuality
//
// The UI renders the FILTERED signal (not raw).
// The alert engine uses the FILTERED signal (not raw).
// ════════════════════════════════════════════════════════════════

interface IngestPayload {
  entityId: string
  lat: number
  lng: number
  accuracy?: number
  battery?: number
  speedKmh?: number
  source: string
  observedAt?: string
  metadata?: {
    url?: string
    placeName?: string
    extractionMethod?: string
    [key: string]: unknown
  }
}

function validatePayload(payload: IngestPayload): { valid: boolean; error?: string } {
  if (!payload.entityId) return { valid: false, error: 'entityId required' }
  if (payload.lat == null || payload.lng == null) return { valid: false, error: 'lat and lng required' }
  if (typeof payload.lat !== 'number' || typeof payload.lng !== 'number') return { valid: false, error: 'lat and lng must be numbers' }
  if (payload.lat < -90 || payload.lat > 90) return { valid: false, error: 'lat must be between -90 and 90' }
  if (payload.lng < -180 || payload.lng > 180) return { valid: false, error: 'lng must be between -180 and 180' }
  if (payload.accuracy != null && payload.accuracy < 0) return { valid: false, error: 'accuracy must be positive' }
  if (payload.battery != null && (payload.battery < 0 || payload.battery > 100)) return { valid: false, error: 'battery must be 0-100' }
  if (payload.speedKmh != null && payload.speedKmh < 0) return { valid: false, error: 'speedKmh must be positive' }
  if (!payload.source) return { valid: false, error: 'source required' }
  return { valid: true }
}

export async function POST(req: NextRequest) {
  const body: IngestPayload = await req.json()

  // ── STEP 1: VALIDATE ──
  const validation = validatePayload(body)
  if (!validation.valid) {
    return NextResponse.json({ ok: false, error: validation.error }, { status: 400, headers: CORS_HEADERS })
  }

  // Verify entity exists
  const entity = await db.entity.findUnique({ where: { id: body.entityId } })
  if (!entity) {
    return NextResponse.json({ ok: false, error: 'Entity not found — el Entity ID no existe en la base de datos' }, { status: 404, headers: CORS_HEADERS })
  }

  // ── STEP 2: FETCH HISTORY (for Kalman filter context) ──
  // Get last 20 sightings for this entity to initialize the filter
  const recentSightings = await db.sighting.findMany({
    where: { entityId: body.entityId },
    orderBy: { observedAt: 'desc' },
    take: 10,
  })

  const observedAt = body.observedAt ? new Date(body.observedAt) : new Date()

  // Convert DB records to historical points for the filter
  const history: HistoricalPoint[] = recentSightings
    .reverse() // oldest first for the filter
    .map(s => ({
      lat: s.filteredLat ?? s.lat, // use filtered coords if available
      lng: s.filteredLng ?? s.lng,
      observedAt: s.observedAt,
      accuracy: s.accuracy,
      speedKmh: s.speedKmh,
      confidence: s.confidence,
    }))

  // ── STEP 3: INITIALIZE KALMAN FILTER WITH HISTORY ──
  const kalmanFilter = new KalmanFilter()

  // Warm up the filter with historical data so it's not cold-starting
  if (history.length > 0) {
    // Initialize with the oldest point we have
    const firstPoint = history[0]
    kalmanFilter.reset(firstPoint.lat, firstPoint.lng)

    // Feed remaining historical points to warm up the filter
    for (let i = 1; i < history.length; i++) {
      const p = history[i]
      kalmanFilter.update(
        p.lat,
        p.lng,
        p.accuracy,
        p.observedAt.getTime()
      )
    }
  }

  // ── STEP 4: RUN SIGNAL PIPELINE ──
  const rawSignal: RawSignal = {
    lat: body.lat,
    lng: body.lng,
    accuracy: body.accuracy ?? null,
    speedKmh: body.speedKmh ?? null,
    battery: body.battery ?? null,
    source: body.source,
    observedAt,
  }

  const pipelineResult: SignalPipelineResult = runSignalPipeline(
    rawSignal,
    history,
    kalmanFilter
  )

  // ── STEP 5: STORE SIGHTING (raw + filtered + classified + derived) ──
  const sourceLabel = body.metadata?.extractionMethod
    ? `${body.source}:${body.metadata.extractionMethod}`
    : body.source

  const sighting = await db.sighting.create({
    data: {
      entityId: body.entityId,
      // RAW signal
      lat: body.lat,
      lng: body.lng,
      // FILTERED signal
      filteredLat: pipelineResult.filtered.lat,
      filteredLng: pipelineResult.filtered.lng,
      // Context
      accuracy: body.accuracy ?? null,
      battery: body.battery ?? null,
      speedKmh: pipelineResult.classified.speedKmh,
      // CLASSIFIED signal
      heading: pipelineResult.classified.heading,
      movementState: pipelineResult.classified.movementState,
      // DERIVED signal
      confidence: pipelineResult.confidence,
      signalQuality: pipelineResult.signalQuality,
      // Source
      source: sourceLabel,
      observedAt,
    },
  })

  // ── STEP 6: CHECK ALERT ZONES (confidence-gated, using FILTERED signal) ──
  const prev = recentSightings.length > 0 ? recentSightings[0] : null
  const alerts = await checkAlertZones({
    entityId: body.entityId,
    sightingId: sighting.id,
    prevLat: prev?.filteredLat ?? prev?.lat ?? null,
    prevLng: prev?.filteredLng ?? prev?.lng ?? null,
    newLat: pipelineResult.filtered.lat,
    newLng: pipelineResult.filtered.lng,
    observedAt,
    prevObservedAt: prev?.observedAt ?? null,
    // V3: Confidence-gated alerts
    confidence: pipelineResult.confidence,
    movementState: pipelineResult.classified.movementState,
    signalQuality: pipelineResult.signalQuality,
  })

  // ── RESPONSE ──
  return NextResponse.json({
    ok: true,
    sighting: {
      id: sighting.id,
      // Raw signal
      lat: sighting.lat,
      lng: sighting.lng,
      // Filtered signal
      filteredLat: sighting.filteredLat,
      filteredLng: sighting.filteredLng,
      observedAt: sighting.observedAt.toISOString(),
      battery: sighting.battery,
      speedKmh: sighting.speedKmh,
      source: sighting.source,
      // V3 fields
      accuracy: sighting.accuracy,
      confidence: sighting.confidence,
      heading: sighting.heading,
      movementState: sighting.movementState,
      signalQuality: sighting.signalQuality,
    },
    pipeline: {
      filtered: {
        lat: pipelineResult.filtered.lat,
        lng: pipelineResult.filtered.lng,
        kalmanGain: pipelineResult.filtered.kalmanGain,
        smoothingApplied: Math.round(pipelineResult.filtered.smoothingApplied * 10) / 10,
        isClamped: pipelineResult.filtered.isClamped,
      },
      classified: {
        movementState: pipelineResult.classified.movementState,
        heading: pipelineResult.classified.heading,
        isTurning: pipelineResult.classified.isTurning,
        anomalyFlags: pipelineResult.classified.anomalyFlags,
      },
      confidence: pipelineResult.confidence,
      signalQuality: pipelineResult.signalQuality,
      confidenceTier: pipelineResult.confidenceTier,
      isDuplicate: pipelineResult.isDuplicate,
      normalizedSource: pipelineResult.normalized.normalizedSource,
      // V3.1: Probabilistic truth model
      uncertaintyRadiusM: pipelineResult.uncertaintyRadiusM,
      isEstimate: pipelineResult.isEstimate,
    },
    alerts,
  }, { headers: CORS_HEADERS })
}
