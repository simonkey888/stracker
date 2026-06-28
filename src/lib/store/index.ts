// ════════════════════════════════════════════════════════════════
// V2 MAIN STORE — Zustand with Slices
// ════════════════════════════════════════════════════════════════
//
// Slices:
//   locationSlice   → position, movement, signal
//   navigationSlice → route, ETA, destination
//   alertSlice      → anomaly, arrival events
//   settingsSlice   → simulation, preferences
//
// No mega-store. Each slice owns its domain.
//
// ════════════════════════════════════════════════════════════════

import { create } from 'zustand'
import { createLocationSlice, type LocationSlice } from './location-slice'
import { createNavigationSlice, type NavigationSlice } from './navigation-slice'
import { createAlertSlice, type AlertSlice } from './alert-slice'
import { createSettingsSlice, type SettingsSlice } from './settings-slice'

export type AppStore = LocationSlice & NavigationSlice & AlertSlice & SettingsSlice

export const useAppStore = create<AppStore>()((...a) => ({
  ...createLocationSlice(...a),
  ...createNavigationSlice(...a),
  ...createAlertSlice(...a),
  ...createSettingsSlice(...a),
}))
