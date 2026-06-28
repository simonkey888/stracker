import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { computeStaleness, computeReliabilityTier, haversine } from '@/lib/observer-types'


export function generateStaticParams() { return [] }
// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const entity = await db.entity.findUnique({
    where: { id },
    include: {
      sightings: { orderBy: { observedAt: 'desc' }, take: 1 },
      alertZones: { where: { enabled: true } },
    },
  })

  if (!entity) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const last = entity.sightings[0]
  const stalenessMs = last ? computeStaleness(last.observedAt) : Date.now()

  // Get trajectory (last 50 sightings)
  const trajectory = await db.sighting.findMany({
    where: { entityId: id },
    orderBy: { observedAt: 'desc' },
    take: 50,
    select: { lat: true, lng: true, observedAt: true, speedKmh: true, battery: true },
  })

  return NextResponse.json({
    id: entity.id,
    label: entity.label,
    kind: entity.kind,
    createdAt: entity.createdAt.toISOString(),
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
    trajectory: trajectory.reverse().map(s => ({
      lat: s.lat,
      lng: s.lng,
      observedAt: s.observedAt.toISOString(),
      speedKmh: s.speedKmh,
      battery: s.battery,
    })),
    alertZones: entity.alertZones.map(z => ({
      id: z.id,
      label: z.label,
      lat: z.lat,
      lng: z.lng,
      radiusMeters: z.radiusMeters,
      onArrival: z.onArrival,
      onDeparture: z.onDeparture,
    })),
  })
}
