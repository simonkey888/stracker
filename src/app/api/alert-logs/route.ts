import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

export async function GET() {
  const logs = await db.alertLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { zone: { select: { label: true } } },
  })

  return NextResponse.json(logs.map(l => ({
    id: l.id,
    zoneId: l.zoneId,
    zoneLabel: l.zone.label,
    type: l.type,
    message: l.message,
    notifiedVia: l.notifiedVia,
    createdAt: l.createdAt.toISOString(),
  })))
}
