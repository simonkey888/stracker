'use client'

import dynamic from 'next/dynamic'

// TEMPORAL: Mostrar el visor del mega JSON para Gemini (toggle interno a STRACKER).
// Para restaurar STRACKER como default, cambiar la línea de return a <TrackerView />
// y eliminar la importación de GeminiJsonViewer.
const GeminiJsonViewer = dynamic(() => import('@/components/tracker/GeminiJsonViewer').then(m => m.GeminiJsonViewer), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[100dvh] flex items-center justify-center" style={{ background: '#0b0f14' }}>
      <div className="flex flex-col items-center gap-3">
        <span
          className="w-2.5 h-2.5 rounded-full"
          style={{ background: '#0a84ff', animation: 'led-pulse-calm 1.4s ease-in-out infinite' }}
        />
        <span className="micro-telemetry">Cargando análisis…</span>
      </div>
    </div>
  ),
})

// Mantenido para restore rápido
const TrackerView = dynamic(() => import('@/components/tracker/TrackerView'), {
  ssr: false,
})

export default function Home() {
  // V9: restaurado a TrackerView para verificar compact height-aware redesign.
  // Para volver al visor JSON, cambiar a <GeminiJsonViewer />.
  return <TrackerView />
}
