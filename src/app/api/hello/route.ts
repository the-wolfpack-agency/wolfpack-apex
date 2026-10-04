// PUBLIC - simple hello API endpoint, no authentication required
import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ message: 'Hello, World!' });
}