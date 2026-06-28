// ════════════════════════════════════════════════════════════════
// V2 SETTINGS SLICE — Simulation & Preferences
// ════════════════════════════════════════════════════════════════

export type SimulationProfile = 'walking' | 'bike' | 'car_city' | 'car_highway'

export interface SimulationSpeedProfile {
  label: string
  minKmh: number
  maxKmh: number
}

export const SPEED_PROFILES: Record<SimulationProfile, SimulationSpeedProfile> = {
  walking: { label: 'Caminando', minKmh: 4, maxKmh: 6 },
  bike: { label: 'Bicicleta', minKmh: 15, maxKmh: 25 },
  car_city: { label: 'Auto ciudad', minKmh: 25, maxKmh: 60 },
  car_highway: { label: 'Auto ruta', minKmh: 80, maxKmh: 120 },
}

export interface SettingsState {
  simulationEnabled: boolean
  simulationProfile: SimulationProfile
  autoFetch: boolean
  fetchIntervalMs: number
}

export interface SettingsActions {
  toggleSimulation: () => void
  setSimulationProfile: (profile: SimulationProfile) => void
  toggleAutoFetch: () => void
  setFetchInterval: (ms: number) => void
}

export type SettingsSlice = SettingsState & SettingsActions

// ── INITIAL STATE ──

export const initialSettings: SettingsState = {
  simulationEnabled: false,
  simulationProfile: 'car_city',
  autoFetch: true,
  fetchIntervalMs: 10000,
}

// ── SLICE FACTORY ──

export function createSettingsSlice(set: any): SettingsSlice {
  return {
    ...initialSettings,

    toggleSimulation: () => set((s: SettingsState) => ({
      simulationEnabled: !s.simulationEnabled,
    })),

    setSimulationProfile: (simulationProfile: SimulationProfile) => set({ simulationProfile }),

    toggleAutoFetch: () => set((s: SettingsState) => ({
      autoFetch: !s.autoFetch,
    })),

    setFetchInterval: (fetchIntervalMs: number) => set({ fetchIntervalMs }),
  }
}
