'use client'

import { X, Clock, MapPin } from 'lucide-react'
import { format } from 'date-fns'
import { es } from 'date-fns/locale'

interface SightingItem {
  id: string
  lat: number
  lng: number
  observedAt: string
  battery: number | null
  speedKmh: number | null
}

interface HistorySheetProps {
  sightings: SightingItem[]
  isOpen: boolean
  onClose: () => void
  onSightingClick?: (s: SightingItem) => void
}

export default function HistorySheet({ sightings, isOpen, onClose, onSightingClick }: HistorySheetProps) {
  if (!isOpen) return null

  // Group sightings by day
  const groups: Record<string, SightingItem[]> = {}
  for (const s of sightings) {
    const day = format(new Date(s.observedAt), 'yyyy-MM-dd')
    if (!groups[day]) groups[day] = []
    groups[day].push(s)
  }

  const dayLabels: Record<string, string> = {}
  const today = format(new Date(), 'yyyy-MM-dd')
  const yesterday = format(new Date(Date.now() - 86400000), 'yyyy-MM-dd')
  dayLabels[today] = 'Hoy'
  dayLabels[yesterday] = 'Ayer'

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      
      {/* Sheet */}
      <div className="relative mt-auto bg-zinc-900 rounded-t-2xl max-h-[85vh] flex flex-col animate-slide-up">
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 bg-zinc-600 rounded-full" />
        </div>
        
        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-white">Historial</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-zinc-800">
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        {/* Timeline */}
        <div className="overflow-y-auto flex-1 p-4 space-y-6">
          {Object.entries(groups)
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([day, items]) => (
              <div key={day}>
                <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                  {dayLabels[day] || format(new Date(day + 'T12:00:00'), "EEEE d 'de' MMMM", { locale: es })}
                </div>
                <div className="space-y-1">
                  {items.map((s, i) => (
                    <button
                      key={s.id}
                      onClick={() => onSightingClick?.(s)}
                      className="w-full flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-zinc-800/50 text-left transition-colors"
                    >
                      {/* Timeline dot */}
                      <div className="flex flex-col items-center">
                        <div className={`w-2 h-2 rounded-full ${i === 0 ? 'bg-indigo-400' : 'bg-zinc-600'}`} />
                        {i < items.length - 1 && <div className="w-px h-6 bg-zinc-700 mt-1" />}
                      </div>
                      
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <Clock className="w-3 h-3 text-zinc-500" />
                          <span className="text-sm text-zinc-300">
                            {format(new Date(s.observedAt), 'HH:mm')}
                          </span>
                          {s.speedKmh !== null && s.speedKmh > 0 && (
                            <span className="text-xs text-zinc-500">
                              · {Math.round(s.speedKmh)} km/h
                            </span>
                          )}
                          {s.battery !== null && (
                            <span className="text-xs text-zinc-500">
                              · {s.battery}%
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1 mt-0.5">
                          <MapPin className="w-3 h-3 text-zinc-600" />
                          <span className="text-xs text-zinc-500 truncate">
                            {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                          </span>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          
          {sightings.length === 0 && (
            <div className="text-center py-8 text-zinc-500">
              Sin registros
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
