import { db } from '@/lib/db'
import { NextRequest, NextResponse } from 'next/server'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const { searchParams } = request.nextUrl
    const limit = parseInt(searchParams.get('limit') || '50', 10)
    const offset = parseInt(searchParams.get('offset') || '0', 10)

    const entity = await db.entity.findUnique({ where: { id } })
    if (!entity) {
      return NextResponse.json({ error: 'Entity not found' }, { status: 404 })
    }

    const [sightings, total] = await Promise.all([
      db.sighting.findMany({
        where: { entityId: id },
        orderBy: { observedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      db.sighting.count({ where: { entityId: id } }),
    ])

    const result = sightings.map((s) => ({
      id: s.id,
      entityId: s.entityId,
      lat: s.lat,
      lng: s.lng,
      observedAt: s.observedAt.toISOString(),
      battery: s.battery,
      speedKmh: s.speedKmh,
      source: s.source,
      createdAt: s.createdAt.toISOString(),
    }))

    return NextResponse.json({ sightings: result, total, limit, offset })
  } catch (error) {
    console.error('GET /api/entities/[id]/sightings error:', error)
    return NextResponse.json({ error: 'Failed to fetch sightings' }, { status: 500 })
  }
}
