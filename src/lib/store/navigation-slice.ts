// ════════════════════════════════════════════════════════════════
// V2 NAVIGATION SLICE — Route, ETA, Destination
// ════════════════════════════════════════════════════════════════

export interface NavigationState {
  isNavigating: boolean
  destinationLat: number | null
  destinationLng: number | null
  destinationLabel: string | null
  distanceToDestination: number | null    // meters
  etaMinutes: number | null
  nextStreet: string | null
  distanceToNextTurn: number | null       // meters
  activeInstruction: string | null
  speedLimit: number | null               // km/h
}

export interface NavigationActions {
  startNavigation: (lat: number, lng: number, label?: string) => void
  stopNavigation: () => void
  updateETA: (etaMinutes: number | null) => void
  updateDistance: (meters: number | null) => void
  setNextTurn: (street: string | null, distanceMeters: number | null) => void
  setActiveInstruction: (instruction: string | null) => void
  setSpeedLimit: (limit: number | null) => void
}

export type NavigationSlice = NavigationState & NavigationActions

// ── HOME DEFAULT ──

export const HOME = {
  lat: -34.6037,
  lng: -58.3816,
  label: 'Casa',
} as const

// ── INITIAL STATE ──

export const initialNavigation: NavigationState = {
  isNavigating: false,
  destinationLat: null,
  destinationLng: null,
  destinationLabel: null,
  distanceToDestination: null,
  etaMinutes: null,
  nextStreet: null,
  distanceToNextTurn: null,
  activeInstruction: null,
  speedLimit: null,
}

// ── SLICE FACTORY ──

export function createNavigationSlice(set: any, get: any): NavigationSlice {
  return {
    ...initialNavigation,

    startNavigation: (lat: number, lng: number, label?: string) => set({
      isNavigating: true,
      destinationLat: lat,
      destinationLng: lng,
      destinationLabel: label ?? 'Destino',
    }),

    stopNavigation: () => set({
      isNavigating: false,
      destinationLat: null,
      destinationLng: null,
      destinationLabel: null,
      distanceToDestination: null,
      etaMinutes: null,
      nextStreet: null,
      distanceToNextTurn: null,
      activeInstruction: null,
    }),

    updateETA: (etaMinutes: number | null) => set({ etaMinutes }),

    updateDistance: (distanceToDestination: number | null) => set({ distanceToDestination }),

    setNextTurn: (nextStreet: string | null, distanceToNextTurn: number | null) =>
      set({ nextStreet, distanceToNextTurn }),

    setActiveInstruction: (activeInstruction: string | null) => set({ activeInstruction }),

    setSpeedLimit: (speedLimit: number | null) => set({ speedLimit }),
  }
}
