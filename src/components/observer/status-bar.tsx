'use client'

import { formatStaleness } from '@/lib/observer-types'

interface StatusBarProps {
  stalenessMs: number
  battery: number | null
  speedKmh: number | null
  reliabilityTier: string
}

export default function StatusBar({ stalenessMs, battery, speedKmh, reliabilityTier }: StatusBarProps) {
  const tierConfig: Record<string, { color: string; bg: string; dot: string }> = {
    reliable: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', dot: 'bg-emerald-400' },
    uncertain: { color: 'text-amber-400', bg: 'bg-amber-500/10', dot: 'bg-amber-400' },
    unreliable: { color: 'text-red-400', bg: 'bg-red-500/10', dot: 'bg-red-400' },
    no_data: { color: 'text-zinc-400', bg: 'bg-zinc-500/10', dot: 'bg-zinc-400' },
  }

  const config = tierConfig[reliabilityTier] || tierConfig.no_data

  const batteryIcon = battery === null ? '🔋' 
    : battery > 60 ? '🔋' 
    : battery > 30 ? '🪫' 
    : '🪫'

  const speedIcon = speedKmh === null ? '●' 
    : speedKmh > 50 ? '🚗' 
    : speedKmh > 5 ? '🚶' 
    : '⏸'

  return (
    <div className={`${config.bg} backdrop-blur-md border-t border-white/10 px-4 py-3 flex items-center justify-between`}>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${config.dot} animate-pulse`} />
          <span className={`text-xs font-medium ${config.color}`}>
            {formatStaleness(stalenessMs)}
          </span>
        </div>
      </div>
      
      <div className="flex items-center gap-4">
        {battery !== null && (
          <div className="flex items-center gap-1">
            <span className="text-sm">{batteryIcon}</span>
            <span className={`text-xs font-medium ${battery > 30 ? 'text-zinc-300' : 'text-red-400'}`}>
              {battery}%
            </span>
          </div>
        )}
        
        {speedKmh !== null && (
          <div className="flex items-center gap-1">
            <span className="text-sm">{speedIcon}</span>
            <span className="text-xs font-medium text-zinc-300">
              {speedKmh > 0 ? `${Math.round(speedKmh)}` : '0'} km/h
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
