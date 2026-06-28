'use client'

import { X, Plus, Trash2, Home, Building2, MapPin } from 'lucide-react'
import { useState } from 'react'

interface AlertZoneData {
  id: string
  label: string
  lat: number
  lng: number
  radiusMeters: number
  onArrival: boolean
  onDeparture: boolean
  enabled: boolean
}

interface SettingsDialogProps {
  isOpen: boolean
  onClose: () => void
  zones: AlertZoneData[]
  onAddZone: (zone: Partial<AlertZoneData>) => void
  onDeleteZone: (id: string) => void
  onToggleZone: (id: string, enabled: boolean) => void
  telegramChatId: string
  onTelegramChange: (id: string) => void
  lastObservedAt: string | null
  sessionHealthy: boolean
}

export default function SettingsDialog({
  isOpen, onClose, zones, onAddZone, onDeleteZone, onToggleZone,
  telegramChatId, onTelegramChange, lastObservedAt, sessionHealthy
}: SettingsDialogProps) {
  const [showAddZone, setShowAddZone] = useState(false)
  const [newZone, setNewZone] = useState({ label: '', lat: '', lng: '', radius: '200' })

  if (!isOpen) return null

  const handleAddZone = () => {
    if (!newZone.label || !newZone.lat || !newZone.lng) return
    onAddZone({
      label: newZone.label,
      lat: parseFloat(newZone.lat),
      lng: parseFloat(newZone.lng),
      radiusMeters: parseInt(newZone.radius) || 200,
      onArrival: true,
      onDeparture: true,
      enabled: true,
    })
    setNewZone({ label: '', lat: '', lng: '', radius: '200' })
    setShowAddZone(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      
      <div className="relative mt-auto bg-zinc-900 rounded-t-2xl max-h-[85vh] flex flex-col animate-slide-up">
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 bg-zinc-600 rounded-full" />
        </div>
        
        <div className="flex items-center justify-between px-4 pb-3 border-b border-zinc-800">
          <h2 className="text-lg font-semibold text-white">Configuración</h2>
          <button onClick={onClose} className="p-1 rounded-full hover:bg-zinc-800">
            <X className="w-5 h-5 text-zinc-400" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1 p-4 space-y-6">
          {/* Session Status */}
          <div>
            <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Sesión</div>
            <div className="flex items-center gap-2 text-sm">
              <div className={`w-2 h-2 rounded-full ${sessionHealthy ? 'bg-emerald-400' : 'bg-red-400'}`} />
              <span className="text-zinc-300">{sessionHealthy ? 'Señal activa' : 'Señal perdida'}</span>
            </div>
            {lastObservedAt && (
              <div className="text-xs text-zinc-500 mt-1">
                Última observación: {new Date(lastObservedAt).toLocaleString('es-AR')}
              </div>
            )}
          </div>

          {/* Alert Zones */}
          <div>
            <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Zonas de alerta</div>
            <div className="space-y-2">
              {zones.map(zone => (
                <div key={zone.id} className="flex items-center gap-3 p-3 bg-zinc-800/50 rounded-lg">
                  <div className="text-amber-400">
                    {zone.label.toLowerCase().includes('casa') ? <Home className="w-4 h-4" /> 
                    : zone.label.toLowerCase().includes('trabajo') || zone.label.toLowerCase().includes('work') ? <Building2 className="w-4 h-4" />
                    : <MapPin className="w-4 h-4" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white">{zone.label}</div>
                    <div className="text-xs text-zinc-500">{zone.radiusMeters}m radio</div>
                  </div>
                  <button
                    onClick={() => onToggleZone(zone.id, !zone.enabled)}
                    className={`px-2 py-1 rounded text-xs ${zone.enabled ? 'bg-amber-500/20 text-amber-400' : 'bg-zinc-700 text-zinc-500'}`}
                  >
                    {zone.enabled ? 'ON' : 'OFF'}
                  </button>
                  <button onClick={() => onDeleteZone(zone.id)} className="p-1 hover:bg-zinc-700 rounded">
                    <Trash2 className="w-4 h-4 text-zinc-500" />
                  </button>
                </div>
              ))}
              
              {!showAddZone ? (
                <button
                  onClick={() => setShowAddZone(true)}
                  className="w-full flex items-center justify-center gap-2 p-3 border border-dashed border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-300 hover:border-zinc-600"
                >
                  <Plus className="w-4 h-4" />
                  <span className="text-sm">Agregar zona</span>
                </button>
              ) : (
                <div className="p-3 bg-zinc-800/50 rounded-lg space-y-2">
                  <input
                    type="text"
                    placeholder="Nombre (ej: Casa)"
                    value={newZone.label}
                    onChange={e => setNewZone(p => ({ ...p, label: e.target.value }))}
                    className="w-full bg-zinc-700 text-white text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Lat"
                      value={newZone.lat}
                      onChange={e => setNewZone(p => ({ ...p, lat: e.target.value }))}
                      className="flex-1 bg-zinc-700 text-white text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-amber-500"
                    />
                    <input
                      type="text"
                      placeholder="Lng"
                      value={newZone.lng}
                      onChange={e => setNewZone(p => ({ ...p, lng: e.target.value }))}
                      className="flex-1 bg-zinc-700 text-white text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-amber-500"
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="Radio (metros)"
                    value={newZone.radius}
                    onChange={e => setNewZone(p => ({ ...p, radius: e.target.value }))}
                    className="w-full bg-zinc-700 text-white text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-amber-500"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={handleAddZone}
                      className="flex-1 bg-amber-500 text-black text-sm font-medium py-2 rounded hover:bg-amber-400"
                    >
                      Guardar
                    </button>
                    <button
                      onClick={() => setShowAddZone(false)}
                      className="flex-1 bg-zinc-700 text-zinc-300 text-sm py-2 rounded hover:bg-zinc-600"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Telegram */}
          <div>
            <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">Notificaciones</div>
            <div className="space-y-2">
              <input
                type="text"
                placeholder="Telegram Chat ID"
                value={telegramChatId}
                onChange={e => onTelegramChange(e.target.value)}
                className="w-full bg-zinc-800 text-white text-sm rounded px-3 py-2 outline-none focus:ring-1 focus:ring-blue-500"
              />
              <p className="text-xs text-zinc-500">
                Mensaje @userinfobot en Telegram para obtener tu Chat ID
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
