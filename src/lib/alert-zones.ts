import { db } from './db'
import { haversine } from './observer-types'

// ════════════════════════════════════════════════════════════════
// ALERT ORCHESTRATOR — CONFIDENCE-GATED (V3)
// ════════════════════════════════════════════════════════════════
//
// V3 Rule: IF entity enters AlertZone AND confidence > threshold
//          THEN emit alert event, log AlertLog
//
// Only triggers alerts for signals with sufficient confidence.
// No alert on ANOMALOUS or INVALID signals.
//
// This file MUST only be imported from API routes (server-side).
// It imports 'db' which uses 'pg' — not available in browser.
// ════════════════════════════════════════════════════════════════

const ALERT_CONFIDENCE_THRESHOLD = 0.4  // Minimum confidence to trigger alerts
const ALERT_MIN_STALINESS_MS = 0        // Minimum staleness for signal_recovered

export interface CheckAlertZonesParams {
  entityId: string
  sightingId: string
  prevLat: number | null
  prevLng: number | null
  newLat: number
  newLng: number
  observedAt?: Date
  prevObservedAt?: Date | null
  // V3: Confidence-gated alerts
  confidence?: number | null
  movementState?: string | null
  signalQuality?: string | null
}

export async function checkAlertZones(params: CheckAlertZonesParams): Promise<string[]> {
  const {
    entityId,
    sightingId,
    prevLat,
    prevLng,
    newLat,
    newLng,
    observedAt,
    prevObservedAt,
    confidence,
    movementState,
    signalQuality,
  } = params

  // ── CONFIDENCE GATE ──
  // Skip alert processing for low-confidence, ANOMALOUS, or UNRELIABLE signals
  const isAnomalous = movementState === 'ANOMALOUS'
  const isUnreliable = signalQuality === 'UNRELIABLE'
  const belowThreshold = confidence != null && confidence < ALERT_CONFIDENCE_THRESHOLD

  if (isAnomalous || isUnreliable || belowThreshold) {
    // Still log that we received a signal, but don't trigger zone alerts
    // (the signal pipeline already flagged it as unreliable)
    return []
  }

  const zones = await db.alertZone.findMany({
    where: { entityId, enabled: true },
  })

  const alerts: string[] = []

  for (const zone of zones) {
    const dist = haversine(newLat, newLng, zone.lat, zone.lng)
    const wasInside = prevLat !== null && prevLng !== null
      ? haversine(prevLat, prevLng, zone.lat, zone.lng) <= zone.radiusMeters
      : false
    const isInside = dist <= zone.radiusMeters

    // Arrival: wasn't inside → now inside
    if (zone.onArrival && !wasInside && isInside) {
      await db.alertLog.create({
        data: {
          zoneId: zone.id,
          sightingId,
          type: 'arrival',
          message: `📍 Llegada a ${zone.label}${confidence != null ? ` (conf: ${(confidence * 100).toFixed(0)}%)` : ''}`,
        },
      })
      alerts.push(`arrival:${zone.label}`)
    }

    // Departure: was inside → now outside
    if (zone.onDeparture && wasInside && !isInside) {
      await db.alertLog.create({
        data: {
          zoneId: zone.id,
          sightingId,
          type: 'departure',
          message: `🚶 Salida de ${zone.label}${confidence != null ? ` (conf: ${(confidence * 100).toFixed(0)}%)` : ''}`,
        },
      })
      alerts.push(`departure:${zone.label}`)
    }

    // Signal recovered: inside zone after 30+ min gap
    if (isInside && prevObservedAt && observedAt) {
      const staleness = observedAt.getTime() - prevObservedAt.getTime()
      if (staleness > 30 * 60 * 1000) {
        await db.alertLog.create({
          data: {
            zoneId: zone.id,
            sightingId,
            type: 'signal_recovered',
            message: `📶 Señal recuperada en ${zone.label} (sin señal ${Math.round(staleness / 60000)}m)${confidence != null ? ` conf: ${(confidence * 100).toFixed(0)}%` : ''}`,
          },
        })
        alerts.push(`signal_recovered:${zone.label}`)
      }
    }
  }

  return alerts
}
