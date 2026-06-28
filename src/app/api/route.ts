import { NextResponse } from "next/server";

// Required for output: export — prevents Next.js from trying to prerender this API route.
export const dynamic = 'force-static'

export async function GET() {
  return NextResponse.json({ message: "Hello, world!" });
}