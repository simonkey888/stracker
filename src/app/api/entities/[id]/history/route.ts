import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const url = new URL(req.url)
  const limit = parseInt(url.searchParams.get('limit') || '100')
  const offset = parseInt(url.searchParams.get('offset') || '0')

  const [sightings, total] = await Promise.all([
    db.sighting.findMany({
      where: { entityId: id },
      orderBy: { observedAt: 'desc' },
      take: limit,
      skip: offset,
    }),
    db.sighting.count({ where: { entityId: id } }),
  ])

  return NextResponse.json({
    sightings: sightings.map(s => ({
      id: s.id,
      lat: s.lat,
      lng: s.lng,
      observedAt: s.observedAt.toISOString(),
      battery: s.battery,
      speedKmh: s.speedKmh,
      source: s.source,
    })),
    total,
    limit,
    offset,
  })
}
