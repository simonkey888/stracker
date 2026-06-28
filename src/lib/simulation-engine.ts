// ════════════════════════════════════════════════════════════════
// V2 MOVEMENT SIMULATION ENGINE
// ════════════════════════════════════════════════════════════════
//
// Pipeline:
//   currentPosition → nextWaypoint → bearing → speedProfile
//       → noiseModel → Kalman smooth → render
//
// Speed Profiles:
//   walking:     4–6 km/h
//   bike:        15–25 km/h
//   car_city:    25–60 km/h
//   car_highway: 80–120 km/h
//
// Noise Model:
//   - Small lateral deviations (±2-5m per step)
//   - GPS jitter (±3-8m random walk)
//   - Speed deceleration near waypoints
//   - Never a perfect line
//
// ════════════════════════════════════════════════════════════════

import { type SimulationProfile, SPEED_PROFILES } from './store/settings-slice'
import { smooth, haversineMeters, computeBearing } from './store/location-slice'

// ── TYPES ──

export interface Waypoint {
  lat: number
  lng: number
}

export interface SimulationStep {
  lat: number
  lng: number
  speedKmh: number
  heading: number
  accuracy: number
  confidence: number
}

// ── BUENOS AIRES ROUTE WAYPOINTS ──
// A realistic route around the default home location

export const DEFAULT_ROUTE: Waypoint[] = [
  { lat: -34.6037, lng: -58.3816 },  // Start: Casa
  { lat: -34.6042, lng: -58.3800 },  // East along street
  { lat: -34.6050, lng: -58.3785 },  // NE corner
  { lat: -34.6058, lng: -58.3770 },  // Continue NE
  { lat: -34.6065, lng: -58.3750 },  // North
  { lat: -34.6075, lng: -58.3740 },  // NW turn
  { lat: -34.6085, lng: -58.3735 },  // Continue NW
  { lat: -34.6090, lng: -58.3755 },  // West turn
  { lat: -34.6085, lng: -58.3780 },  // SW
  { lat: -34.6078, lng: -58.3800 },  // Continue SW
  { lat: -34.6068, lng: -58.3810 },  // South
  { lat: -34.6058, lng: -58.3818 },  // SE
  { lat: -34.6048, lng: -58.3820 },  // Continue SE
  { lat: -34.6040, lng: -58.3818 },  // Approaching home
  { lat: -34.6037, lng: -58.3816 },  // Home
]

// ── SIMULATION STATE ──

interface SimState {
  currentWaypointIndex: number
  progress: number           // 0-1 between waypoints
  lat: number
  lng: number
  prevLat: number
  prevLng: number
  currentSpeed: number       // km/h
  targetSpeed: number        // km/h
  jitterX: number            // accumulated lateral jitter (meters)
  jitterY: number            // accumulated longitudinal jitter (meters)
  stepCount: number
}

// ── NOISE GENERATION ──

function gaussianRandom(mean: number = 0, stdDev: number = 1): number {
  const u1 = Math.random()
  const u2 = Math.random()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return z * stdDev + mean
}

// ── SIMULATION ENGINE CLASS ──

export class SimulationEngine {
  private state: SimState
  private route: Waypoint[]
  private profile: SimulationProfile
  private isRunning: boolean = false
  private onStep: ((step: SimulationStep) => void) | null = null
  private intervalId: ReturnType<typeof setInterval> | null = null

  constructor(
    route: Waypoint[] = DEFAULT_ROUTE,
    profile: SimulationProfile = 'car_city'
  ) {
    this.route = route
    this.profile = profile
    this.state = {
      currentWaypointIndex: 0,
      progress: 0,
      lat: route[0].lat,
      lng: route[0].lng,
      prevLat: route[0].lat,
      prevLng: route[0].lng,
      currentSpeed: 0,
      targetSpeed: this.pickSpeed(),
      jitterX: 0,
      jitterY: 0,
      stepCount: 0,
    }
  }

  // ── SPEED PICKER ──

  private pickSpeed(): number {
    const p = SPEED_PROFILES[this.profile]
    return p.minKmh + Math.random() * (p.maxKmh - p.minKmh)
  }

  // ── COMPUTE NEXT STEP ──

  private computeStep(): SimulationStep {
    const { route, state, profile } = this
    const s = state

    // Save previous position
    s.prevLat = s.lat
    s.prevLng = s.lng

    // Current waypoint pair
    const fromIdx = s.currentWaypointIndex
    const toIdx = (fromIdx + 1) % route.length
    const from = route[fromIdx]
    const to = route[toIdx]

    // Distance between waypoints (meters)
    const segmentDist = haversineMeters(from.lat, from.lng, to.lat, to.lng)

    // Speed with deceleration near waypoints
    // Decelerate when progress > 0.8 to simulate turns/stops
    let speedFactor = 1.0
    if (s.progress > 0.8) {
      speedFactor = 1.0 - (s.progress - 0.8) * 2.5  // slows to ~0.5 at progress=1.0
    }
    // Also decelerate right after a turn (progress < 0.15)
    if (s.progress < 0.15 && s.stepCount > 0) {
      speedFactor = 0.5 + s.progress * 3.3  // accelerates from 0.5 to 1.0
    }

    // Smooth speed towards target
    s.targetSpeed += (Math.random() - 0.5) * 3  // slight speed variation
    const p = SPEED_PROFILES[profile]
    s.targetSpeed = Math.max(p.minKmh, Math.min(p.maxKmh, s.targetSpeed))
    s.currentSpeed = smooth(s.currentSpeed, s.targetSpeed * speedFactor, 0.15)

    // How far to move this step (1 Hz = 1 step/second)
    // speed in km/h → meters/second
    const speedMs = (s.currentSpeed / 3.6)
    // Update interval is 1000ms (1 Hz)
    const stepDistMeters = speedMs * 1.0  // 1 second per step

    // Progress increment
    const progressInc = segmentDist > 0 ? stepDistMeters / segmentDist : 0
    s.progress += progressInc

    // Interpolate position
    let newLat = from.lat + (to.lat - from.lat) * s.progress
    let newLng = from.lng + (to.lng - from.lng) * s.progress

    // ── NOISE MODEL ──
    // GPS jitter: random walk with mean reversion
    s.jitterX = smooth(s.jitterX, gaussianRandom(0, 2.5), 0.3)  // lateral jitter
    s.jitterY = smooth(s.jitterY, gaussianRandom(0, 2.0), 0.3)  // longitudinal jitter

    // Small lateral deviation (perpendicular to heading)
    const heading = computeBearing(s.prevLat, s.prevLng, to.lat, to.lng)
    const headingRad = heading * Math.PI / 180

    // Convert jitter from meters to degrees
    const jitterLat = (s.jitterY * Math.cos(headingRad) - s.jitterX * Math.sin(headingRad)) / 111320
    const jitterLng = (s.jitterX * Math.cos(headingRad) + s.jitterY * Math.sin(headingRad)) /
                       (111320 * Math.cos(newLat * Math.PI / 180))

    newLat += jitterLat
    newLng += jitterLng

    // Clamp to reasonable bounds (Buenos Aires area)
    newLat = Math.max(-34.62, Math.min(-34.59, newLat))
    newLng = Math.max(-58.39, Math.min(-58.37, newLng))

    s.lat = newLat
    s.lng = newLng

    // Move to next waypoint if progress >= 1
    if (s.progress >= 1.0) {
      s.progress = 0
      s.currentWaypointIndex = toIdx
      s.targetSpeed = this.pickSpeed()  // new speed for new segment
    }

    s.stepCount++

    // Compute confidence based on how "clean" the signal is
    // Lower accuracy = lower confidence
    const accuracy = 5 + Math.abs(s.jitterX) * 2 + Math.abs(s.jitterY) * 2  // ~5-15m
    const confidence = Math.max(0.4, Math.min(0.95, 1.0 - accuracy / 100))

    return {
      lat: s.lat,
      lng: s.lng,
      speedKmh: Math.round(s.currentSpeed * 10) / 10,
      heading: Math.round(heading * 10) / 10,
      accuracy: Math.round(accuracy),
      confidence: Math.round(confidence * 100) / 100,
    }
  }

  // ── START / STOP ──

  start(onStep: (step: SimulationStep) => void): void {
    if (this.isRunning) return
    this.onStep = onStep
    this.isRunning = true

    // 1 Hz GPS updates
    this.intervalId = setInterval(() => {
      if (!this.isRunning || !this.onStep) return
      const step = this.computeStep()
      this.onStep(step)
    }, 1000)
  }

  stop(): void {
    this.isRunning = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.onStep = null
  }

  // ── SET PROFILE ──

  setProfile(profile: SimulationProfile): void {
    this.profile = profile
    this.state.targetSpeed = this.pickSpeed()
  }

  // ── RESET ──

  reset(): void {
    this.stop()
    this.state = {
      currentWaypointIndex: 0,
      progress: 0,
      lat: this.route[0].lat,
      lng: this.route[0].lng,
      prevLat: this.route[0].lat,
      prevLng: this.route[0].lng,
      currentSpeed: 0,
      targetSpeed: this.pickSpeed(),
      jitterX: 0,
      jitterY: 0,
      stepCount: 0,
    }
  }

  // ── GET STATE ──

  getIsRunning(): boolean {
    return this.isRunning
  }

  getCurrentPosition(): { lat: number; lng: number } {
    return { lat: this.state.lat, lng: this.state.lng }
  }
}
