import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export async function GET() {
  try {
    const filePath = join(process.cwd(), 'download', 'tracker.zip')
    const fileBuffer = readFileSync(filePath)

    return new NextResponse(fileBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="tracker.zip"',
        'Content-Length': fileBuffer.length.toString(),
      },
    })
  } catch (error) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }
}
