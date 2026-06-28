import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

export async function GET() {
  const filePath = join(process.cwd(), 's-tracker-extension.zip')
  const fileBuffer = readFileSync(filePath)

  return new NextResponse(fileBuffer, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="s-tracker-extension.zip"',
      'Content-Length': fileBuffer.length.toString(),
    },
  })
}
