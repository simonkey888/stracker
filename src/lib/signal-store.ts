// ════════════════════════════════════════════════════════════════
// V4 SIGNAL STORE — ZUSTAND SINGLE SOURCE OF TRUTH
// ════════════════════════════════════════════════════════════════
//
// Apple Maps Navigation Store.
// State machine: idle → navigating → alert → arrival
// All UI components read from this store.
//
// ════════════════════════════════════════════════════════════════

import { create } from 'zustand'
import type {
  MovementState,
  SignalQuality,
  ConfidenceTier,
  NormalizedSource,
} from '@/lib/signal-pipeline'

// ── TYPES ──

export type AppState = 'idle' | 'navigating' | 'alert' | 'arrival'
export type SignalStateLabel = 'SNAPSHOT' | 'MOVING' | 'IDLE' | 'STALE' | 'ANOMALOUS'

export interface SignalState {
  filteredLat: number | null
  filteredLng: number | null
  rawLat: number | null
  rawLng: number | null
  battery: number | null
  speedKmh: number | null
  observedAt: Date | null
  source: string | null
  accuracy: number | null
  movementState: MovementState
  heading: number | null
  isTurning: boolean
  anomalyFlags: string[]
  confidence: number
  signalQuality: SignalQuality
  confidenceTier: ConfidenceTier
  kalmanGain: number
  smoothingApplied: number
  isClamped: boolean
  isDuplicate: boolean
  normalizedSource: NormalizedSource
  uncertaintyRadiusM: number
  isEstimate: boolean
  stalenessMs: number
}

export interface TrajectoryPoint {
  lat: number
  lng: number
  observedAt: Date
  confidence?: number | null
  speedKmh?: number | null
  accuracy?: number | null
}

export interface AlertZone {
  id: string
  label: string
  lat: number
  lng: number
  radiusMeters: number
  onArrival: boolean
  onDeparture: boolean
  enabled: boolean
}

export interface EntityState {
  entityId: string | null
  trajectory: TrajectoryPoint[]
  alertZones: AlertZone[]
  stalenessMs: number
}

export interface ProximityState {
  distanceToHomeM: number | null
  bearingToHome: number | null
  etaMinutes: number | null
  isNearHome: boolean
  direction: 'approaching' | 'departing' | 'stationary'
}

export interface AudioState {
  lastTriggeredRule: string | null
  isPlaying: boolean
  volume: number
}

export interface NavigationState {
  isNavigating: boolean
  distanceToNextTurn: number | null  // meters
  nextStreet: string | null
  eta: number | null                // minutes
  activeInstruction: string | null
  speed: number | null              // km/h
  speedLimit: number | null         // km/h
}

export interface UIState {
  autoSimulate: boolean
  showDetailSheet: boolean
}

// ── DERIVATION: SignalStateLabel ──

function deriveSignalStateLabel(
  movementState: MovementState,
  stalenessMs: number
): SignalStateLabel {
  if (movementState === 'ANOMALOUS') return 'ANOMALOUS'
  if (stalenessMs > 10 * 60 * 1000) return 'STALE'
  const movingStates: MovementState[] = ['SLOW', 'WALKING', 'VEHICULAR', 'HIGH_SPEED']
  if (movingStates.includes(movementState)) return 'MOVING'
  if (movementState === 'STATIONARY' && stalenessMs < 5 * 60 * 1000) return 'SNAPSHOT'
  return 'IDLE'
}

// ── DERIVATION: AppState ──

function deriveAppState(
  signalLabel: SignalStateLabel,
  proximity: ProximityState,
  navigation: NavigationState
): AppState {
  if (signalLabel === 'ANOMALOUS') return 'alert'
  if (proximity.isNearHome && proximity.direction === 'approaching') return 'arrival'
  if (navigation.isNavigating || signalLabel === 'MOVING') return 'navigating'
  return 'idle'
}

// ── HAVERSINE ──

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

function computeBearing(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const dLng = (toLng - fromLng) * Math.PI / 180
  const lat1 = fromLat * Math.PI / 180
  const lat2 = toLat * Math.PI / 180
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// ── STORE INTERFACE ──

export interface SignalStoreState {
  signal: SignalState
  entity: EntityState
  proximity: ProximityState
  audio: AudioState
  navigation: NavigationState
  ui: UIState
  signalStateLabel: SignalStateLabel
  appState: AppState
}

export interface SignalStoreActions {
  updateSignal: (data: Partial<SignalState>) => void
  updateStaleness: () => void
  setEntityId: (id: string | null) => void
  setTrajectory: (points: TrajectoryPoint[]) => void
  setAlertZones: (zones: AlertZone[]) => void
  setProximity: (homeLat: number, homeLng: number) => void
  triggerAudio: (rule: string) => void
  clearAudio: () => void
  toggleUI: (key: keyof UIState) => void
  updateNavigation: (data: Partial<NavigationState>) => void
}

export type SignalStore = SignalStoreState & SignalStoreActions

// ── INITIAL STATE ──

const initialSignal: SignalState = {
  filteredLat: null,
  filteredLng: null,
  rawLat: null,
  rawLng: null,
  battery: null,
  speedKmh: null,
  observedAt: null,
  source: null,
  accuracy: null,
  movementState: 'UNKNOWN',
  heading: null,
  isTurning: false,
  anomalyFlags: [],
  confidence: 0,
  signalQuality: 'UNRELIABLE',
  confidenceTier: 'invalid',
  kalmanGain: 0,
  smoothingApplied: 0,
  isClamped: false,
  isDuplicate: false,
  normalizedSource: 'unknown',
  uncertaintyRadiusM: 0,
  isEstimate: true,
  stalenessMs: 0,
}

const initialEntity: EntityState = {
  entityId: null,
  trajectory: [],
  alertZones: [],
  stalenessMs: 0,
}

const initialProximity: ProximityState = {
  distanceToHomeM: null,
  bearingToHome: null,
  etaMinutes: null,
  isNearHome: false,
  direction: 'stationary',
}

const initialAudio: AudioState = {
  lastTriggeredRule: null,
  isPlaying: false,
  volume: 0.7,
}

const initialNavigation: NavigationState = {
  isNavigating: false,
  distanceToNextTurn: null,
  nextStreet: null,
  eta: null,
  activeInstruction: null,
  speed: null,
  speedLimit: null,
}

const initialUI: UIState = {
  autoSimulate: false,
  showDetailSheet: false,
}

// ── STORE CREATION ──

export const useSignalStore = create<SignalStore>((set, get) => ({
  signal: initialSignal,
  entity: initialEntity,
  proximity: initialProximity,
  audio: initialAudio,
  navigation: initialNavigation,
  ui: initialUI,

  signalStateLabel: deriveSignalStateLabel(initialSignal.movementState, initialSignal.stalenessMs),
  appState: 'idle',

  updateSignal: (data) => {
    set((state) => {
      const newSignal = { ...state.signal, ...data }
      if (data.observedAt) {
        newSignal.stalenessMs = Date.now() - new Date(data.observedAt).getTime()
      }
      const signalLabel = deriveSignalStateLabel(newSignal.movementState, newSignal.stalenessMs)
      const appState = deriveAppState(signalLabel, state.proximity, state.navigation)

      return {
        signal: newSignal,
        signalStateLabel: signalLabel,
        appState,
      }
    })
  },

  updateStaleness: () => {
    set((state) => {
      const newStalenessMs = state.signal.stalenessMs + 1000
      const signalLabel = deriveSignalStateLabel(state.signal.movementState, newStalenessMs)
      const appState = deriveAppState(signalLabel, state.proximity, state.navigation)

      return {
        signal: { ...state.signal, stalenessMs: newStalenessMs },
        signalStateLabel: signalLabel,
        appState,
        entity: { ...state.entity, stalenessMs: newStalenessMs },
      }
    })
  },

  setEntityId: (id) => {
    set((state) => ({ entity: { ...state.entity, entityId: id } }))
  },

  setTrajectory: (points) => {
    set((state) => ({ entity: { ...state.entity, trajectory: points } }))
  },

  setAlertZones: (zones) => {
    set((state) => ({ entity: { ...state.entity, alertZones: zones } }))
  },

  setProximity: (homeLat, homeLng) => {
    const { signal, navigation } = get()
    if (signal.filteredLat === null || signal.filteredLng === null) return

    const distanceM = haversineMeters(signal.filteredLat, signal.filteredLng, homeLat, homeLng)
    const bearing = computeBearing(signal.filteredLat, signal.filteredLng, homeLat, homeLng)
    const speedKmh = signal.speedKmh ?? 5
    const etaMinutes = speedKmh > 0 ? (distanceM / 1000) / speedKmh * 60 : null
    const isNearHome = distanceM <= 200

    // Direction classification
    let direction: 'approaching' | 'departing' | 'stationary' = 'stationary'
    if (signal.movementState === 'STATIONARY') {
      direction = 'stationary'
    } else if (signal.heading !== null) {
      let diff = ((bearing - signal.heading) % 360 + 540) % 360 - 180
      diff = Math.abs(diff)
      direction = diff < 90 ? 'approaching' : 'departing'
    }

    const newProximity: ProximityState = {
      distanceToHomeM: Math.round(distanceM),
      bearingToHome: Math.round(bearing),
      etaMinutes: etaMinutes !== null ? Math.round(etaMinutes) : null,
      isNearHome,
      direction,
    }

    // Derive navigation instructions from proximity
    const newNavigation: NavigationState = {
      ...navigation,
      speed: signal.speedKmh,
      eta: newProximity.etaMinutes,
      isNavigating: signal.movementState !== 'UNKNOWN' && signal.movementState !== 'STATIONARY',
      // Derive next turn info from proximity
      nextStreet: isNearHome ? 'Casa' : null,
      distanceToNextTurn: isNearHome ? distanceM : null,
      activeInstruction: isNearHome && direction === 'approaching'
        ? 'Llegando a casa'
        : direction === 'approaching'
        ? 'Acercándose'
        : null,
    }

    const signalLabel = get().signalStateLabel
    const appState = deriveAppState(signalLabel, newProximity, newNavigation)

    set({
      proximity: newProximity,
      navigation: newNavigation,
      appState,
    })
  },

  triggerAudio: (rule) => {
    set({
      audio: {
        lastTriggeredRule: rule,
        isPlaying: true,
        volume: get().audio.volume,
      },
    })
  },

  clearAudio: () => {
    set((state) => ({ audio: { ...state.audio, isPlaying: false } }))
  },

  toggleUI: (key) => {
    set((state) => ({ ui: { ...state.ui, [key]: !state.ui[key] } }))
  },

  updateNavigation: (data) => {
    set((state) => {
      const newNavigation = { ...state.navigation, ...data }
      const appState = deriveAppState(state.signalStateLabel, state.proximity, newNavigation)
      return { navigation: newNavigation, appState }
    })
  },
}))
