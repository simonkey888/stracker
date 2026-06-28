/**
 * EVENT-SOURCED KERNEL SERVICE — Node.js Process Manager
 *
 * Manages the Python kernel_service_boot.py as a long-lived child process.
 * Also starts the WebSocket push service.
 *
 * Architecture: EVENT_SOURCED_KERNEL_MODEL
 *   Python kernel (always on, 2Hz state loop) on port 3003
 *       ↓ event log + versioned snapshots
 *   WebSocket push service on port 3004
 *       ↓ real-time push
 *   Frontend (React + Leaflet + socket.io)
 */

import { spawn, ChildProcess } from 'child_process'
import { resolve } from 'path'

const KERNEL_PORT = 3003
const PYTHON_SCRIPT = resolve(process.cwd(), 'stracker/kernel_service_boot.py')
const MAX_RESTARTS = 10
const RESTART_DELAY_MS = 3000

let kernelProcess: ChildProcess | null = null
let restartCount = 0
let isStarted = false

/**
 * Start the persistent kernel service as a child process.
 */
export function startKernelService(): void {
  if (isStarted) return
  isStarted = true
  _spawnKernel()
}

function _spawnKernel(): void {
  console.log(`[kernel-client] Spawning Python event-sourced kernel on port ${KERNEL_PORT}...`)

  kernelProcess = spawn('python3', [PYTHON_SCRIPT], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: {
      ...process.env,
      KERNEL_PORT: String(KERNEL_PORT),
    },
  })

  kernelProcess.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach((line) => console.log(`[kernel:py] ${line}`))
  })

  kernelProcess.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach((line) => console.error(`[kernel:py:err] ${line}`))
  })

  kernelProcess.on('exit', (code, signal) => {
    console.log(`[kernel-client] Process exited with code=${code} signal=${signal}`)
    kernelProcess = null

    if (restartCount < MAX_RESTARTS) {
      restartCount++
      console.log(
        `[kernel-client] Restarting in ${RESTART_DELAY_MS}ms (attempt ${restartCount}/${MAX_RESTARTS})...`
      )
      setTimeout(_spawnKernel, RESTART_DELAY_MS)
    } else {
      console.error(`[kernel-client] Max restarts (${MAX_RESTARTS}) reached. Giving up.`)
    }
  })
}

/**
 * Fetch the latest cached snapshot from the kernel service.
 */
export async function getKernelSnapshot(): Promise<any | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${KERNEL_PORT}/snapshot`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Fetch a specific versioned snapshot (time-travel).
 */
export async function getKernelSnapshotVersion(version: number): Promise<any | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${KERNEL_PORT}/snapshot/v${version}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

/**
 * Fetch events from the kernel event store.
 */
export async function getKernelEvents(since: number = 0, type?: string, limit: number = 200): Promise<any> {
  try {
    let url = `http://127.0.0.1:${KERNEL_PORT}/events?since=${since}&limit=${limit}`
    if (type) url += `&type=${type}`
    const response = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return { events: [], count: 0 }
    return await response.json()
  } catch {
    return { events: [], count: 0 }
  }
}

/**
 * Fetch available snapshot versions.
 */
export async function getKernelVersions(): Promise<any> {
  try {
    const response = await fetch(`http://127.0.0.1:${KERNEL_PORT}/snapshot/versions`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) return { versions: [] }
    return await response.json()
  } catch {
    return { versions: [] }
  }
}

/**
 * Check if the kernel service is healthy.
 */
export async function isKernelHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${KERNEL_PORT}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) return false
    const data = await response.json()
    return data.healthy === true
  } catch {
    return false
  }
}

// Auto-start is DISABLED — kernel is managed by mini-services/kernel-service
// This avoids child process management issues with Next.js HMR.
// The kernel runs as a separate process started by mini-services/kernel-service.
// if (typeof window === 'undefined') {
//   startKernelService()
// }
