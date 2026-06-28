import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { computeStaleness, computeReliabilityTier } from '@/lib/observer-types'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

export async function GET() {
  const entities = await db.entity.findMany({
    include: {
      sightings: {
        orderBy: { observedAt: 'desc' },
        take: 1,
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const result = entities.map(e => {
    const last = e.sightings[0]
    const stalenessMs = last ? computeStaleness(last.observedAt) : Date.now()
    return {
      id: e.id,
      label: e.label,
      kind: e.kind,
      createdAt: e.createdAt.toISOString(),
      lastSighting: last ? {
        id: last.id,
        lat: last.lat,
        lng: last.lng,
        observedAt: last.observedAt.toISOString(),
        battery: last.battery,
        speedKmh: last.speedKmh,
        source: last.source,
      } : null,
      stalenessMs,
      reliabilityTier: computeReliabilityTier(stalenessMs),
    }
  })

  return NextResponse.json(result)
}
