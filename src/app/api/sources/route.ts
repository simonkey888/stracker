import { NextResponse } from 'next/server'

// Sources are not a separate model in the current schema.
// The `source` field is a string on Sighting (e.g. "cloud", "simulation", "manual").
// This route returns the distinct source values currently in use.

export async function GET() {
  try {
    return NextResponse.json([
      { id: 'cloud', label: 'Google Maps', kind: 'cloud' },
      { id: 'simulation', label: 'Simulación', kind: 'simulation' },
      { id: 'manual', label: 'Manual', kind: 'manual' },
    ])
  } catch (error) {
    console.error('GET /api/sources error:', error)
    return NextResponse.json({ error: 'Failed to fetch sources' }, { status: 500 })
  }
}
