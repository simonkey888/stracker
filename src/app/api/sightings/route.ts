import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { haversine } from '@/lib/observer-types'

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { entityId, lat, lng, battery, source } = body

  if (!entityId || lat == null || lng == null) {
    return NextResponse.json({ error: 'entityId, lat, lng required' }, { status: 400 })
  }

  // Get previous sighting for speed calculation
  const prev = await db.sighting.findFirst({
    where: { entityId },
    orderBy: { observedAt: 'desc' },
  })

  let speedKmh: number | null = null
  if (prev) {
    const distM = haversine(prev.lat, prev.lng, lat, lng)
    const deltaH = (Date.now() - prev.observedAt.getTime()) / (1000 * 60 * 60)
    if (deltaH > 0) speedKmh = Math.round((distM / 1000 / deltaH) * 10) / 10
  }

  const sighting = await db.sighting.create({
    data: {
      entityId,
      lat,
      lng,
      observedAt: new Date(),
      battery: battery ?? null,
      speedKmh,
      source: source || 'cloud',
    },
  })

  // Check alert zones
  const zones = await db.alertZone.findMany({
    where: { entityId, enabled: true },
  })

  const alerts: string[] = []
  for (const zone of zones) {
    const dist = haversine(lat, lng, zone.lat, zone.lng)
    const wasInside = prev ? haversine(prev.lat, prev.lng, zone.lat, zone.lng) <= zone.radiusMeters : false
    const isInside = dist <= zone.radiusMeters

    if (zone.onArrival && !wasInside && isInside) {
      await db.alertLog.create({
        data: {
          zoneId: zone.id,
          sightingId: sighting.id,
          type: 'arrival',
          message: `📍 Llegada a ${zone.label}`,
        },
      })
      alerts.push(`arrival:${zone.label}`)
    }

    if (zone.onDeparture && wasInside && !isInside) {
      await db.alertLog.create({
        data: {
          zoneId: zone.id,
          sightingId: sighting.id,
          type: 'departure',
          message: `🚶 Salida de ${zone.label}`,
        },
      })
      alerts.push(`departure:${zone.label}`)
    }
  }

  return NextResponse.json({
    sighting: {
      id: sighting.id,
      lat: sighting.lat,
      lng: sighting.lng,
      observedAt: sighting.observedAt.toISOString(),
      battery: sighting.battery,
      speedKmh: sighting.speedKmh,
    },
    alerts,
  })
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const limit = parseInt(url.searchParams.get('limit') || '50')
  const sightings = await db.sighting.findMany({
    orderBy: { observedAt: 'desc' },
    take: limit,
    include: { entity: { select: { label: true } } },
  })

  return NextResponse.json(sightings.map(s => ({
    id: s.id,
    entityId: s.entityId,
    entityLabel: s.entity.label,
    lat: s.lat,
    lng: s.lng,
    observedAt: s.observedAt.toISOString(),
    battery: s.battery,
    speedKmh: s.speedKmh,
    source: s.source,
  })))
}
