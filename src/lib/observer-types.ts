export interface SightingData {
  id: string
  entityId: string
  lat: number
  lng: number
  observedAt: string
  battery: number | null
  speedKmh: number | null
  source: string
  createdAt: string
}

export interface EntityWithState {
  id: string
  label: string
  kind: string
  createdAt: string
  lastSighting: SightingData | null
  stalenessMs: number
  reliabilityTier: 'reliable' | 'uncertain' | 'unreliable' | 'no_data'
}

export interface AlertZoneData {
  id: string
  entityId: string
  label: string
  lat: number
  lng: number
  radiusMeters: number
  onArrival: boolean
  onDeparture: boolean
  telegramChatId: string | null
  enabled: boolean
}

export interface AlertLogData {
  id: string
  zoneId: string
  type: string
  message: string
  notifiedVia: string
  createdAt: string
  zoneLabel?: string
}

export function computeStaleness(observedAt: Date): number {
  return Date.now() - observedAt.getTime()
}

export function computeReliabilityTier(stalenessMs: number): 'reliable' | 'uncertain' | 'unreliable' | 'no_data' {
  if (stalenessMs < 2 * 60 * 1000) return 'reliable'       // < 2 min
  if (stalenessMs < 15 * 60 * 1000) return 'uncertain'     // < 15 min
  if (stalenessMs < 2 * 60 * 60 * 1000) return 'unreliable' // < 2 hours
  return 'no_data'
}

export function formatStaleness(ms: number): string {
  if (ms < 60 * 1000) return `hace ${Math.floor(ms / 1000)}s`
  if (ms < 60 * 60 * 1000) return `hace ${Math.floor(ms / 60000)}m`
  if (ms < 24 * 60 * 60 * 1000) return `hace ${Math.floor(ms / 3600000)}h`
  return `hace ${Math.floor(ms / 86400000)}d`
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
