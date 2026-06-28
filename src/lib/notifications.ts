/**
 * INTEL_01 (stracker_v5.4_intelligence): Reactive Notifications.
 *
 * Push-notification engine driven by state transitions: estado_anterior !=
 * estado_nuevo. Three triggers fire `new Notification()`:
 *
 *  - GEOFENCE_EXIT: distance(pos, home) crossed from < threshold to > threshold.
 *  - SPEED_SPIKE:   average speed > 80 km/h (vehicle / highway detection).
 *  - STAGNATION:    device stayed > 2h at an unknown (non-home/non-work) spot.
 *
 * AlertCooldown: no more than one alert of the same type per 30 min. Prevents
 * notification spam during oscillating geofence edges or repeated speed spikes.
 *
 * Permission is requested once on dashboard load via requestPermission().
 */

export type AlertType = 'GEOFENCE_EXIT' | 'SPEED_SPIKE' | 'STAGNATION'

export interface AlertPayload {
  type: AlertType
  title: string
  body: string
  ts: number
}

const COOLDOWN_MS = 30 * 60 * 1000 // 30 minutes per alert type
const SPEED_SPIKE_THRESHOLD = 80 // km/h
const STAGNATION_MS = 2 * 60 * 60 * 1000 // 2 hours

/** Map of last-fired timestamp per alert type (cooldown ledger). */
const lastFired: Record<AlertType, number> = {
  GEOFENCE_EXIT: 0,
  SPEED_SPIKE: 0,
  STAGNATION: 0,
}

/** True if the Notification API is available and permission was granted. */
export function notificationsEnabled(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted'
}

/** Requests permission once on dashboard load. Safe to call repeatedly. */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied'
  if (Notification.permission === 'granted' || Notification.permission === 'denied') {
    return Notification.permission
  }
  try {
    return await Notification.requestPermission()
  } catch {
    return 'denied'
  }
}

/** Fires a notification iff (a) permission granted and (b) the cooldown for
 *  this alert type has elapsed. Returns true if the notification was shown. */
export function fireAlert(payload: AlertPayload): boolean {
  if (!notificationsEnabled()) return false
  const now = payload.ts || Date.now()
  if (now - lastFired[payload.type] < COOLDOWN_MS) return false // debounce
  lastFired[payload.type] = now
  try {
    new Notification(payload.title, { body: payload.body, silent: false })
    return true
  } catch {
    return false
  }
}

export interface AlertState {
  insideGeofence: boolean | null
  avgSpeedKmh: number | null
  /** ISO ts of the first point at the current unknown spot, or null if
   *  currently at home/work or no position. */
  unknownSpotSince: number | null
}

/**
 * Diffs prev vs next state and fires the appropriate alerts.
 * This is the "estado_anterior != estado_nuevo" comparator — only transitions
 * trigger notifications, not steady states.
 *
 * @param prev  previous observed state (null on first poll — no alerts)
 * @param next  current observed state
 * @param ctx   context: home radius + label for the notification body
 * @returns array of alerts that actually fired (post-cooldown)
 */
export function evaluateAlerts(
  prev: AlertState | null,
  next: AlertState,
  ctx: { homeRadiusM: number },
): AlertPayload[] {
  const now = Date.now()
  const fired: AlertPayload[] = []
  if (!prev) return fired // first poll: baseline, no transitions yet

  // ── GEOFENCE_EXIT: was inside → now outside ──
  if (prev.insideGeofence === true && next.insideGeofence === false) {
    const a: AlertPayload = {
      type: 'GEOFENCE_EXIT',
      title: 'Geocerca: salida',
      body: `El objetivo salió del perímetro de casa (>${ctx.homeRadiusM}m).`,
      ts: now,
    }
    if (fireAlert(a)) fired.push(a)
  }

  // ── SPEED_SPIKE: crossed the 80 km/h threshold upward ──
  const prevSpeed = prev.avgSpeedKmh ?? 0
  const nextSpeed = next.avgSpeedKmh ?? 0
  if (prevSpeed <= SPEED_SPIKE_THRESHOLD && nextSpeed > SPEED_SPIKE_THRESHOLD) {
    const a: AlertPayload = {
      type: 'SPEED_SPIKE',
      title: 'Velocidad alta',
      body: `Velocidad media ${nextSpeed.toFixed(0)} km/h — posible vehículo/carretera.`,
      ts: now,
    }
    if (fireAlert(a)) fired.push(a)
  }

  // ── STAGNATION: unknown spot dwell time just crossed 2h ──
  if (
    prev.unknownSpotSince != null &&
    next.unknownSpotSince != null &&
    prev.unknownSpotSince === next.unknownSpotSince &&
    now - next.unknownSpotSince >= STAGNATION_MS &&
    now - next.unknownSpotSince < STAGNATION_MS + 5 * 60 * 1000 // fire once near the threshold, not forever
  ) {
    const a: AlertPayload = {
      type: 'STAGNATION',
      title: 'Estancia prolongada',
      body: 'El objetivo lleva más de 2h en una ubicación desconocida.',
      ts: now,
    }
    if (fireAlert(a)) fired.push(a)
  }

  return fired
}

/** Thresholds exported for UI / testing introspection. */
export const THRESHOLDS = {
  SPEED_SPIKE_KMH: SPEED_SPIKE_THRESHOLD,
  STAGNATION_MS,
  COOLDOWN_MS,
} as const
