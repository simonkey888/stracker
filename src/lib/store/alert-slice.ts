// ════════════════════════════════════════════════════════════════
// V2 ALERT SLICE — Anomaly Detection & Arrival Events
// ════════════════════════════════════════════════════════════════

import { deriveScreenState } from './location-slice'

export type AlertType = 'anomalous_movement' | 'signal_lost' | 'arrival' | 'departure' | null

export interface AlertState {
  isAnomalous: boolean
  isNearDestination: boolean
  activeAlert: AlertType
  alertMessage: string | null
  lastAlertAt: Date | null
}

export interface AlertActions {
  setAnomalous: (anomalous: boolean) => void
  setNearDestination: (near: boolean) => void
  triggerAlert: (type: AlertType, message: string) => void
  clearAlert: () => void
}

export type AlertSlice = AlertState & AlertActions

// ── INITIAL STATE ──

export const initialAlert: AlertState = {
  isAnomalous: false,
  isNearDestination: false,
  activeAlert: null,
  alertMessage: null,
  lastAlertAt: null,
}

// ── SLICE FACTORY ──

export function createAlertSlice(set: any, get: any): AlertSlice {
  return {
    ...initialAlert,

    setAnomalous: (isAnomalous: boolean) => {
      const state = get()
      const screenState = deriveScreenState(state.movementState, state.isNearDestination, isAnomalous)
      set({ isAnomalous, screenState })
    },

    setNearDestination: (isNearDestination: boolean) => {
      const state = get()
      const screenState = deriveScreenState(state.movementState, isNearDestination, state.isAnomalous)
      set({ isNearDestination, screenState })
    },

    triggerAlert: (type: AlertType, message: string) => set({
      activeAlert: type,
      alertMessage: message,
      lastAlertAt: new Date(),
    }),

    clearAlert: () => set({
      activeAlert: null,
      alertMessage: null,
    }),
  }
}
