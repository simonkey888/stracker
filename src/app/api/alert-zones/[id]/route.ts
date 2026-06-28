import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

// V6.5: required for static export — no static params to pre-render (API route).
export function generateStaticParams() {
  return []
}

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
