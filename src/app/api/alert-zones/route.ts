import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET() {
  const zones = await db.alertZone.findMany({
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json(zones)
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { entityId, label, lat, lng, radiusMeters, onArrival, onDeparture, telegramChatId } = body

  if (!entityId || !label || lat == null || lng == null) {
    return NextResponse.json({ error: 'entityId, label, lat, lng required' }, { status: 400 })
  }

  const zone = await db.alertZone.create({
    data: {
      entityId,
      label,
      lat,
      lng,
      radiusMeters: radiusMeters || 200,
      onArrival: onArrival ?? true,
      onDeparture: onDeparture ?? true,
      telegramChatId: telegramChatId || null,
    },
  })

  return NextResponse.json(zone, { status: 201 })
}
