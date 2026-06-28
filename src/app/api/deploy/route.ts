import { NextRequest, NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

const STRACKER_DIR = '/home/z/my-project/stracker'

const FILES = [
  'tracker_map.py',
  'state_kernel.py',
  'event_engine.py',
  'audio_engine.py',
  'cookie_engine.py',
  'requirements.txt',
  '.gitignore',
  'watchdog.py',
  'refresh_cookies.py',
]

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const file = searchParams.get('file')

  // Serve individual file
  if (file) {
    if (!FILES.includes(file)) {
      return NextResponse.json({ error: 'File not in allowed list' }, { status: 404 })
    }
    const filePath = join(STRACKER_DIR, file)
    if (!existsSync(filePath)) {
      return NextResponse.json({ error: 'File not found on disk' }, { status: 404 })
    }
    const content = readFileSync(filePath, 'utf-8')
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `inline; filename="${file}"`,
        'Cache-Control': 'no-store',
        'X-File-Size': content.length.toString(),
      },
    })
  }

  // Serve manifest of all available files
  const manifest: Record<string, { size: number; hash: string }> = {}
  for (const f of FILES) {
    const filePath = join(STRACKER_DIR, f)
    if (existsSync(filePath)) {
      const stat = await import('fs').then(m => m.statSync(filePath))
      manifest[f] = { size: stat.size, hash: `v6.3-${stat.mtimeMs.toString(36)}` }
    }
  }

  return NextResponse.json({
    version: 'v6.3',
    description: 'EVENT CONTROL ENGINE — Event consumption + cooldown + dedup + ghostrail buffer + camera lock + audio consume-once + mini-bar UI',
    files: manifest,
    deploy_instructions: 'Run: curl -s http://SANDBOX_URL/api/deploy?file=tracker_map.py > tracker_map.py',
  })
}
