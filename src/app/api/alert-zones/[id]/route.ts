import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Required for `output: export` — dynamic API routes must declare
// generateStaticParams. Returning [] means no static paths are
// pre-rendered; the route exists only at runtime via the Python backend.
export function generateStaticParams() {
  return []
}

export const dynamic = 'force-static'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  await db.alertLog.deleteMany({ where: { zoneId: id } })
  await db.alertZone.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json()
  const zone = await db.alertZone.update({
    where: { id },
    data: {
      label: body.label,
      lat: body.lat,
      lng: body.lng,
      radiusMeters: body.radiusMeters,
      onArrival: body.onArrival,
      onDeparture: body.onDeparture,
      enabled: body.enabled,
      telegramChatId: body.telegramChatId,
    },
  })
  return NextResponse.json(zone)
}
