import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

// Returns the first entity ID for auto-configuration of the Chrome Extension
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function GET() {
  const entity = await db.entity.findFirst({ orderBy: { createdAt: 'desc' } })

  return NextResponse.json({
    entityId: entity?.id || null,
    entityLabel: entity?.label || null,
    ingestUrl: '/api/ingest',
  }, { headers: CORS_HEADERS })
}
