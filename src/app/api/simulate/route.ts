import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { haversine } from '@/lib/observer-types'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

// Simulate a new sighting (for demo purposes)
export async function POST(req: NextRequest) {
  const body = await req.json()
  const { entityId } = body

  if (!entityId) {
    return NextResponse.json({ error: 'entityId required' }, { status: 400 })
  }

  // Get last sighting to simulate movement from there
  const last = await db.sighting.findFirst({
    where: { entityId },
    orderBy: { observedAt: 'desc' },
  })

  if (!last) {
    return NextResponse.json({ error: 'No previous sighting to simulate from' }, { status: 400 })
  }

  // Simulate small random movement (50-500m)
  const angle = Math.random() * 2 * Math.PI
  const distance = 50 + Math.random() * 450
  const dLat = (distance * Math.cos(angle)) / 111320
  const dLng = (distance * Math.sin(angle)) / (111320 * Math.cos(last.lat * Math.PI / 180))

  const newLat = last.lat + dLat
  const newLng = last.lng + dLng

  // Compute speed
  const distM = haversine(last.lat, last.lng, newLat, newLng)
  const deltaH = 1 / 60 // Assume 1 minute between sightings
  const speedKmh = Math.round((distM / 1000 / deltaH) * 10) / 10

  // Simulate battery drain
  const battery = last.battery ? Math.max(5, last.battery - Math.floor(Math.random() * 2)) : null

  const sighting = await db.sighting.create({
    data: {
      entityId,
      lat: newLat,
      lng: newLng,
      observedAt: new Date(),
      battery,
      speedKmh,
      source: 'simulation',
    },
  })

  // Check alert zones
  const zones = await db.alertZone.findMany({
    where: { entityId, enabled: true },
  })

  const alerts: string[] = []
  for (const zone of zones) {
    const dist = haversine(newLat, newLng, zone.lat, zone.lng)
    const wasInside = haversine(last.lat, last.lng, zone.lat, zone.lng) <= zone.radiusMeters
    const isInside = dist <= zone.radiusMeters

    if (zone.onArrival && !wasInside && isInside) {
      await db.alertLog.create({
        data: { zoneId: zone.id, sightingId: sighting.id, type: 'arrival', message: `📍 Llegada a ${zone.label}` },
      })
      alerts.push(`arrival:${zone.label}`)
    }
    if (zone.onDeparture && wasInside && !isInside) {
      await db.alertLog.create({
        data: { zoneId: zone.id, sightingId: sighting.id, type: 'departure', message: `🚶 Salida de ${zone.label}` },
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
