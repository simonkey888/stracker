// ════════════════════════════════════════════════════════════════
// V2 LOCATION SLICE — Position, Movement, Signal
// ════════════════════════════════════════════════════════════════

export type MovementState =
  | 'STATIONARY'
  | 'WALKING'
  | 'MOVING'
  | 'FAST_MOVING'
  | 'ANOMALOUS'

export type ScreenState = 'idle' | 'moving' | 'navigating' | 'alert' | 'arrival'

export interface LocationState {
  lat: number
  lng: number
  filteredLat: number
  filteredLng: number
  heading: number | null
  speedKmh: number | null
  movementState: MovementState
  confidence: number
  accuracy: number | null
  observedAt: Date | null
  stalenessMs: number
  screenState: ScreenState
}

export interface LocationActions {
  setPosition: (lat: number, lng: number) => void
  setFilteredPosition: (lat: number, lng: number) => void
  setHeading: (heading: number | null) => void
  setSpeed: (speedKmh: number | null) => void
  setMovementState: (state: MovementState) => void
  setConfidence: (confidence: number) => void
  setAccuracy: (accuracy: number | null) => void
  setObservedAt: (date: Date | null) => void
  tickStaleness: () => void
  setScreenState: (state: ScreenState) => void
}

export type LocationSlice = LocationState & LocationActions

// ── MOVEMENT CLASSIFICATION ──

export function classifyMovement(speedKmh: number | null): MovementState {
  if (speedKmh === null) return 'STATIONARY'
  if (speedKmh < 2) return 'STATIONARY'
  if (speedKmh < 8) return 'WALKING'
  if (speedKmh < 60) return 'MOVING'
  return 'FAST_MOVING'
}

// ── SCREEN STATE DERIVATION ──

export function deriveScreenState(
  movementState: MovementState,
  isNearDestination: boolean,
  isAnomalous: boolean
): ScreenState {
  if (isAnomalous) return 'alert'
  if (isNearDestination) return 'arrival'
  if (movementState === 'FAST_MOVING' || movementState === 'MOVING') return 'navigating'
  if (movementState === 'WALKING') return 'moving'
  return 'idle'
}

// ── KALMAN-LITE ──

export function smooth(prev: number, curr: number, alpha = 0.2): number {
  return prev + (curr - prev) * alpha
}

// ── HAVERSINE ──

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ── BEARING ──

export function computeBearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = (toLng - fromLng) * Math.PI / 180
  const lat1 = fromLat * Math.PI / 180
  const lat2 = toLat * Math.PI / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// ── INITIAL STATE ──

export const initialLocation: LocationState = {
  lat: -34.6037,
  lng: -58.3816,
  filteredLat: -34.6037,
  filteredLng: -58.3816,
  heading: null,
  speedKmh: null,
  movementState: 'STATIONARY',
  confidence: 0,
  accuracy: null,
  observedAt: null,
  stalenessMs: 0,
  screenState: 'idle',
}

// ── SLICE FACTORY ──

export function createLocationSlice(set: any, get: any): LocationSlice {
  return {
    ...initialLocation,

    setPosition: (lat: number, lng: number) => set({ lat, lng }),

    setFilteredPosition: (filteredLat: number, filteredLng: number) => set({ filteredLat, filteredLng }),

    setHeading: (heading: number | null) => set({ heading }),

    setSpeed: (speedKmh: number | null) => {
      const movementState = classifyMovement(speedKmh)
      const state = get()
      const screenState = deriveScreenState(movementState, state.isNearDestination, state.isAnomalous)
      set({ speedKmh, movementState, screenState })
    },

    setMovementState: (movementState: MovementState) => {
      const state = get()
      const screenState = deriveScreenState(movementState, state.isNearDestination, state.isAnomalous)
      set({ movementState, screenState })
    },

    setConfidence: (confidence: number) => set({ confidence }),

    setAccuracy: (accuracy: number | null) => set({ accuracy }),

    setObservedAt: (observedAt: Date | null) => set({
      observedAt,
      stalenessMs: observedAt ? Date.now() - observedAt.getTime() : 0,
    }),

    tickStaleness: () => set((s: LocationState) => ({
      stalenessMs: s.stalenessMs + 1000,
    })),

    setScreenState: (screenState: ScreenState) => set({ screenState }),
  }
}
