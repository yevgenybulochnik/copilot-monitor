/**
 * Per-session state file, written by the extension and read by the status line script. It lets the
 * status line show "◉ 2 monitors" without talking to the extension process.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface SessionState {
  /** The extension process that owns these monitors; a dead owner means nothing is running. */
  readonly ownerPid: number
  readonly updatedAt: number
  readonly running: readonly { readonly id: string; readonly description: string; readonly expiresAt: number }[]
}

export function stateFile(logDir: string, sessionId: string): string {
  // Session IDs are UUIDs; anything else is reduced to a safe file name.
  return join(logDir, "sessions", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
}

/** Writes atomically, so a reader never sees half a file. */
export function writeState(logDir: string, sessionId: string, state: SessionState) {
  const file = stateFile(logDir, sessionId)
  mkdirSync(join(logDir, "sessions"), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
  renameSync(temp, file)
}

export function removeState(logDir: string, sessionId: string) {
  rmSync(stateFile(logDir, sessionId), { force: true })
}

/** Running monitors for a session, or an empty list when the file is missing, stale, or broken. */
export function readRunning(logDir: string, sessionId: string, now = Date.now()): SessionState["running"] {
  let state: SessionState
  try {
    state = JSON.parse(readFileSync(stateFile(logDir, sessionId), "utf8")) as SessionState
  } catch {
    return []
  }
  if (!isAlive(state.ownerPid)) return []
  return (state.running ?? []).filter((m) => m.expiresAt > now)
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    // ESRCH: gone. EPERM: the PID now belongs to another user's process, so not our extension.
    return false
  }
}
