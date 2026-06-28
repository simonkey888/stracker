import { db } from '@/lib/db'
import { NextResponse } from 'next/server'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

export async function GET() {
  try {
    const [totalEntities, totalSightingsToday, recentSightings] = await Promise.all([
      db.entity.count(),
      db.sighting.count({
        where: {
          observedAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      db.sighting.findMany({
        orderBy: { observedAt: 'desc' },
        take: 1,
        include: { entity: true },
      }),
    ])

    return NextResponse.json({
      totalEntities,
      totalSightingsToday,
      lastSeenAt: recentSightings[0]?.observedAt?.toISOString() ?? null,
    })
  } catch (error) {
    console.error('GET /api/stats error:', error)
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 })
  }
}
