import { NextResponse } from 'next/server'
import { readFileSync } from 'fs'
import { join } from 'path'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

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
