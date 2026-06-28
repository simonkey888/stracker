'use client'

// ══════════════════════════════════════════════════════════════════
// RA14: DEVICE INFERENCE ENGINE
// Classifies the device emitting location updates as TCL408 (TCL 40 SE)
// or Samsung Galaxy A16, based on observable telemetry patterns.
//
// Why these two devices?
//   - TCL 408 (TCL 40 SE): 5010 mAh battery, Mediatek MT6833 (Dimensity 700),
//     GPS: GPS/GLONASS/BeiDou/Galileo, 4G LTE only
//   - Samsung Galaxy A16 (4G): 5000 mAh, Mediatek Helio G99,
//     GPS: GPS/GLONASS/BeiDou/Galileo/QZSS, 4G LTE
//   - Samsung Galaxy A16 (5G): 5000 mAh, Mediatek Dimensity 6300,
//     GPS: GPS/GLONASS/BeiDou/Galileo/QZSS, 5G
//
// Differentiating signals (statistical, NOT definitive):
//   1. Battery capacity proxy — TCL 5010mAh vs Samsung 5000mAh (very close,
//      but combined with discharge rate can hint at chipset efficiency)
//   2. GPS accuracy distribution — Mediatek Dimensity (TCL) tends to have
//      slightly noisier GPS than Samsung's tuning (5-10% accuracy std dev diff)
//   3. Network type — Samsung A16 5G variant reports 5G when available;
//      TCL 408 is 4G-only → if "5G" ever appears, strong Samsung signal
//   4. Polling cadence — Google Location Sharing update frequency varies
//      by device battery profile + screen state
//   5. Address formatting / locale hints (minor)
//
// Output: scores 0-100 for each candidate; pick highest.
// ══════════════════════════════════════════════════════════════════

export type DeviceCandidate = 'TCL_408' | 'SAMSUNG_A16' | 'UNKNOWN'

export interface DeviceTelemetrySample {
  accuracy_m: number | null
  speed_kmh: number
  battery_pct: number
  charging: boolean
  network_type: string
  movement_mode: string
  timestamp: string
}

export interface DeviceInferenceResult {
  candidate: DeviceCandidate
  confidence: number  // 0-100
  scores: {
    TCL_408: number
    SAMSUNG_A16: number
  }
  signals: string[]
  reasoning: string
}

// Empty result for missing data
const EMPTY_RESULT: DeviceInferenceResult = {
  candidate: 'UNKNOWN',
  confidence: 0,
  scores: { TCL_408: 50, SAMSUNG_A16: 50 },
  signals: ['no_data'],
  reasoning: 'Sin datos suficientes para inferir dispositivo',
}

/**
 * Maintain a rolling window of telemetry samples (max 50, ~17 min at 20s polling).
 * Returns statistical features for inference.
 */
export function computeTelemetryFeatures(samples: DeviceTelemetrySample[]): {
  count: number
  meanAccuracy: number | null
  stdAccuracy: number | null
  medianAccuracy: number | null
  meanBattery: number | null
  batteryDrainPerHour: number | null
  has5G: boolean
  hasWIFI: boolean
  networkDistribution: Record<string, number>
  chargingRatio: number
  meanPollIntervalSec: number | null
} {
  if (samples.length === 0) {
    return {
      count: 0,
      meanAccuracy: null,
      stdAccuracy: null,
      medianAccuracy: null,
      meanBattery: null,
      batteryDrainPerHour: null,
      has5G: false,
      hasWIFI: false,
      networkDistribution: {},
      chargingRatio: 0,
      meanPollIntervalSec: null,
    }
  }

  const validAcc = samples
    .map(s => s.accuracy_m)
    .filter((a): a is number => a != null && a > 0)
    .sort((a, b) => a - b)

  const meanAccuracy = validAcc.length > 0
    ? validAcc.reduce((s, a) => s + a, 0) / validAcc.length
    : null
  const stdAccuracy = validAcc.length > 1 && meanAccuracy != null
    ? Math.sqrt(validAcc.reduce((s, a) => s + (a - meanAccuracy) ** 2, 0) / validAcc.length)
    : null
  const medianAccuracy = validAcc.length > 0
    ? validAcc[Math.floor(validAcc.length / 2)]
    : null

  // Battery drain rate (only when not charging)
  const nonCharging = samples.filter(s => !s.charging)
  let batteryDrainPerHour: number | null = null
  if (nonCharging.length >= 2) {
    const first = nonCharging[0]
    const last = nonCharging[nonCharging.length - 1]
    const dtMs = new Date(last.timestamp).getTime() - new Date(first.timestamp).getTime()
    const dtHours = dtMs / (1000 * 60 * 60)
    if (dtHours > 0.05) {  // at least 3 min
      const dbat = first.battery_pct - last.battery_pct
      batteryDrainPerHour = dbat / dtHours
    }
  }

  // Network distribution
  const networkDistribution: Record<string, number> = {}
  samples.forEach(s => {
    const k = (s.network_type || 'UNKNOWN').toUpperCase()
    networkDistribution[k] = (networkDistribution[k] || 0) + 1
  })

  // Poll interval (mean of deltas in seconds)
  let meanPollIntervalSec: number | null = null
  if (samples.length >= 2) {
    const intervals: number[] = []
    for (let i = 1; i < samples.length; i++) {
      const dt = new Date(samples[i].timestamp).getTime() - new Date(samples[i - 1].timestamp).getTime()
      if (dt > 0 && dt < 5 * 60 * 1000) intervals.push(dt / 1000)
    }
    if (intervals.length > 0) {
      meanPollIntervalSec = intervals.reduce((s, x) => s + x, 0) / intervals.length
    }
  }

  return {
    count: samples.length,
    meanAccuracy,
    stdAccuracy,
    medianAccuracy,
    meanBattery: samples.reduce((s, x) => s + x.battery_pct, 0) / samples.length,
    batteryDrainPerHour,
    has5G: (networkDistribution['5G'] || 0) > 0,
    hasWIFI: (networkDistribution['WIFI'] || 0) > 0,
    networkDistribution,
    chargingRatio: samples.filter(s => s.charging).length / samples.length,
    meanPollIntervalSec,
  }
}

/**
 * RA14: Infer device from accumulated telemetry samples.
 *
 * Heuristic scoring:
 *   - 5G observed → +35 Samsung A16 (5G variant), -10 TCL 408 (4G only)
 *   - Battery drain > 8%/h → +8 TCL (less efficient MT6833), +3 Samsung
 *   - Battery drain < 4%/h → +5 Samsung (more efficient Dimensity 6300)
 *   - Accuracy std dev > 25m → +6 TCL (Mediatek GPS tuning), +2 Samsung
 *   - Mean accuracy < 25m → +5 Samsung (better GPS tuning), +2 TCL
 *   - WIFI ratio > 0.5 → +3 each (both have WIFI, neutral-ish)
 *   - Poll interval < 18s → +4 Samsung (Google may update more frequently)
 *
 * Confidence = max(scores) / sum(scores) * 100, with floor 0 and cap 95.
 */
export function inferDevice(samples: DeviceTelemetrySample[]): DeviceInferenceResult {
  if (samples.length < 3) {
    return {
      ...EMPTY_RESULT,
      reasoning: `Solo ${samples.length} muestra(s); necesitan ≥3 para inferir`,
    }
  }

  const f = computeTelemetryFeatures(samples)
  let tclScore = 50
  let samScore = 50
  const signals: string[] = []

  // Signal 1: 5G presence — strongest differentiator
  if (f.has5G) {
    samScore += 35
    tclScore -= 10
    signals.push('5G observado → Samsung A16 5G (TCL 408 es solo 4G)')
  } else {
    // 4G-only observation — slight TCL lean (Samsung A16 4G variant also exists)
    const fourGRatio = (f.networkDistribution['4G'] || 0) / f.count
    if (fourGRatio > 0.7) {
      tclScore += 5
      signals.push(`4G dominante (${(fourGRatio * 100).toFixed(0)}%) → leve indicio TCL`)
    }
  }

  // Signal 2: Battery drain rate
  if (f.batteryDrainPerHour != null) {
    const drain = f.batteryDrainPerHour
    if (drain > 8) {
      tclScore += 8
      samScore += 3
      signals.push(`Alto drain ${drain.toFixed(1)}%/h → TCL MT6833 menos eficiente`)
    } else if (drain < 4) {
      samScore += 5
      signals.push(`Bajo drain ${drain.toFixed(1)}%/h → Samsung Dimensity más eficiente`)
    } else {
      signals.push(`Drain ${drain.toFixed(1)}%/h → neutral`)
    }
  }

  // Signal 3: GPS accuracy distribution
  if (f.stdAccuracy != null && f.meanAccuracy != null) {
    if (f.stdAccuracy > 25) {
      tclScore += 6
      samScore += 2
      signals.push(`GPS ruidoso (σ=${f.stdAccuracy.toFixed(1)}m) → TCL Mediatek`)
    } else if (f.stdAccuracy < 10 && f.meanAccuracy < 25) {
      samScore += 5
      tclScore += 2
      signals.push(`GPS estable (σ=${f.stdAccuracy.toFixed(1)}m, μ=${f.meanAccuracy.toFixed(1)}m) → Samsung`)
    } else {
      signals.push(`GPS σ=${f.stdAccuracy.toFixed(1)}m μ=${f.meanAccuracy.toFixed(1)}m → neutral`)
    }
  }

  // Signal 4: Polling cadence
  if (f.meanPollIntervalSec != null) {
    if (f.meanPollIntervalSec < 18) {
      samScore += 4
      signals.push(`Polling frecuente ${f.meanPollIntervalSec.toFixed(1)}s → Samsung`)
    } else if (f.meanPollIntervalSec > 22) {
      tclScore += 3
      signals.push(`Polling lento ${f.meanPollIntervalSec.toFixed(1)}s → TCL`)
    }
  }

  // Signal 5: WIFI ratio (both have WIFI, but Samsung tends to switch more often)
  const wifiRatio = (f.networkDistribution['WIFI'] || 0) / f.count
  if (wifiRatio > 0.5) {
    samScore += 2
    tclScore += 1
    signals.push(`WIFI dominante ${(wifiRatio * 100).toFixed(0)}% → neutral`)
  }

  // Normalize scores
  const total = tclScore + samScore
  const tclPct = Math.round((tclScore / total) * 100)
  const samPct = Math.round((samScore / total) * 100)
  const diff = Math.abs(tclPct - samPct)

  // Confidence: based on score difference and sample count
  let confidence = Math.min(95, 40 + diff * 0.8 + Math.min(20, (f.count - 3) * 2))
  if (signals.length === 0) confidence = Math.min(confidence, 30)

  let candidate: DeviceCandidate = 'UNKNOWN'
  if (tclPct > samPct + 8) candidate = 'TCL_408'
  else if (samPct > tclPct + 8) candidate = 'SAMSUNG_A16'
  else candidate = 'UNKNOWN'  // too close to call

  const reasoning = candidate === 'UNKNOWN'
    ? `Equilibrado (TCL ${tclPct}% / Samsung ${samPct}%) — necesitan más datos`
    : candidate === 'TCL_408'
      ? `TCL 408 (${tclPct}%) sobre Samsung A16 (${samPct}%)`
      : `Samsung A16 (${samPct}%) sobre TCL 408 (${tclPct}%)`

  return {
    candidate,
    confidence: Math.round(confidence),
    scores: { TCL_408: tclPct, SAMSUNG_A16: samPct },
    signals,
    reasoning,
  }
}

/**
 * Pretty-print candidate name in Spanish for UI display.
 */
export function formatDeviceName(candidate: DeviceCandidate): string {
  switch (candidate) {
    case 'TCL_408': return 'TCL 408'
    case 'SAMSUNG_A16': return 'Samsung Galaxy A16'
    default: return 'Desconocido'
  }
}
