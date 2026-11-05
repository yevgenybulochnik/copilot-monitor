/**
 * Monitor engine: runs one event source (a shell command or a WebSocket), turns its output into
 * events, batches them into notifications, and enforces the timeout and rate limit.
 *
 * It has no Copilot dependency, so it can be unit tested on its own. The extension
 * (extension.ts) supplies the handlers that deliver notifications into the session.
 *
 * The same engine backs opencode-monitor; keep the two in step.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { createWriteStream, type WriteStream } from "node:fs"

export type Source =
  | {
      readonly kind: "command"
      readonly command: string
      readonly cwd: string
      readonly shell: string
      readonly env?: Record<string, string | undefined>
    }
  | {
      readonly kind: "ws"
      readonly url: string
      readonly protocols?: readonly string[]
    }

export type EndReason =
  | { readonly type: "exited"; readonly code: number | null; readonly signal: string | null }
  | { readonly type: "closed"; readonly code: number; readonly reason: string; readonly error?: string }
  | { readonly type: "timeout" }
  | { readonly type: "rate-limited"; readonly notifications: number; readonly windowMs: number }
  | { readonly type: "error"; readonly message: string }
  /** Stopped by the agent (monitor_stop) or by the user (the /monitors command). */
  | { readonly type: "stopped"; readonly by?: "agent" | "user" }
  /** Stopped because the session can no longer receive messages. */
  | { readonly type: "shutdown" }
  /** Stopped because the extension process is exiting (CLI exit, /clear, extension reload). */
  | { readonly type: "unloaded" }

export interface Limits {
  /** Events arriving within this window of the first one are grouped into one notification. */
  readonly batchMs: number
  /** Upper bound on the text of one notification; further events in the batch are dropped and counted. */
  readonly maxNotificationBytes: number
  /** Upper bound on one event's text; longer events are cut. */
  readonly maxEventBytes: number
  /** More notifications than this within `rateWindowMs` stops the monitor. */
  readonly maxNotificationsPerWindow: number
  readonly rateWindowMs: number
  /** Grace period between SIGTERM and SIGKILL when stopping a command. */
  readonly killGraceMs: number
}

export const defaultLimits: Limits = {
  batchMs: 200,
  maxNotificationBytes: 8 * 1024,
  maxEventBytes: 2 * 1024,
  maxNotificationsPerWindow: 30,
  rateWindowMs: 60_000,
  killGraceMs: 2_000,
}

export interface Notification {
  /** 1-based notification number. */
  readonly seq: number
  readonly events: readonly string[]
  /** Events dropped from this batch because it exceeded `maxNotificationBytes`. */
  readonly dropped: number
}

export interface Summary {
  readonly reason: EndReason
  /** Total events (lines or frames) seen, including dropped ones. */
  readonly events: number
  readonly notifications: number
  readonly durationMs: number
  /** Last few stderr lines of a command source; empty for WebSockets. */
  readonly stderrTail: readonly string[]
  /** The last event seen, useful context for rate-limit and timeout notices. */
  readonly lastEvent?: string
}

export interface Handlers {
  readonly onNotification: (notification: Notification) => void
  /** Called exactly once, after the final notification has been handed to `onNotification`. */
  readonly onEnd: (summary: Summary) => void
}

export interface MonitorInit {
  readonly id: string
  readonly sessionId: string
  readonly description: string
  readonly source: Source
  readonly timeoutMs: number
  /** File receiving all stdout and stderr (or frames). */
  readonly logFile: string
  readonly limits?: Partial<Limits>
  readonly handlers: Handlers
  /** Injectable clock for tests. */
  readonly now?: () => number
}

const STDERR_TAIL = 8

// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

export function cleanLine(raw: string): string {
  return raw.replace(ANSI, "").replace(/\r$/, "")
}

export function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text
  // Cut by characters, then trim until the byte budget fits (multi-byte safe).
  let cut = text.slice(0, maxBytes)
  while (Buffer.byteLength(cut) > maxBytes) cut = cut.slice(0, -1)
  return `${cut}… [${text.length - cut.length} chars truncated]`
}

/** Splits a byte stream into lines, holding back a trailing partial line until more data arrives. */
export class LineSplitter {
  private buffer = ""
  constructor(private readonly onLine: (line: string) => void) {}
  push(chunk: string) {
    this.buffer += chunk
    let index = this.buffer.indexOf("\n")
    while (index !== -1) {
      this.onLine(this.buffer.slice(0, index))
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf("\n")
    }
  }
  end() {
    if (this.buffer.length > 0) this.onLine(this.buffer)
    this.buffer = ""
  }
}

export type Status = "running" | EndReason["type"]

export class Monitor {
  readonly id: string
  readonly sessionId: string
  readonly description: string
  readonly source: Source
  readonly timeoutMs: number
  readonly logFile: string
  readonly startedAt: number

  private readonly limits: Limits
  private readonly handlers: Handlers
  private readonly now: () => number

  private endReason: EndReason | undefined
  private endedAt: number | undefined
  private eventCount = 0
  private notificationCount = 0
  private lastEvent: string | undefined
  private readonly stderrTail: string[] = []
  private readonly sentAt: number[] = []

  private batch: string[] = []
  private batchBytes = 0
  private batchDropped = 0
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  private timeoutTimer: ReturnType<typeof setTimeout> | undefined
  private killTimer: ReturnType<typeof setTimeout> | undefined

  private child: ChildProcess | undefined
  private socket: WebSocket | undefined
  private log: WriteStream | undefined
  private resolveExited!: () => void

  /**
   * Settles once the source is gone: the command's processes have exited and released its output,
   * or the socket closed. `onEnd` fires earlier, as soon as the monitor stops.
   */
  readonly exited: Promise<void> = new Promise((resolve) => (this.resolveExited = resolve))

  constructor(init: MonitorInit) {
    this.id = init.id
    this.sessionId = init.sessionId
    this.description = init.description
    this.source = init.source
    this.timeoutMs = init.timeoutMs
    this.logFile = init.logFile
    this.limits = { ...defaultLimits, ...init.limits }
    this.handlers = init.handlers
    this.now = init.now ?? Date.now
    this.startedAt = this.now()
  }

  get status(): Status {
    return this.endReason?.type ?? "running"
  }

  get running(): boolean {
    return this.endReason === undefined
  }

  get events(): number {
    return this.eventCount
  }

  get notifications(): number {
    return this.notificationCount
  }

  get durationMs(): number {
    return (this.endedAt ?? this.now()) - this.startedAt
  }

  /** Why the monitor ended, or undefined while it runs. */
  get reason(): EndReason | undefined {
    return this.endReason
  }

  /** When the monitor ended (epoch ms), or undefined while it runs. */
  get endedTime(): number | undefined {
    return this.endedAt
  }

  start() {
    this.log = createWriteStream(this.logFile, { flags: "a" })
    this.log.on("error", () => (this.log = undefined))
    this.timeoutTimer = setTimeout(() => this.finish({ type: "timeout" }), this.timeoutMs)
    if (this.source.kind === "command") this.startCommand(this.source)
    else this.startSocket(this.source)
  }

  /** Stops the monitor. Pending events are still flushed before `onEnd`. */
  stop(reason: EndReason = { type: "stopped" }) {
    this.finish(reason)
  }

  /** Sends SIGKILL to a command's process group that has not exited yet. For shutdown only. */
  forceKill() {
    const pid = this.child?.pid
    if (pid !== undefined) signalGroup(pid, "SIGKILL")
  }

  // ---------------------------------------------------------------------------------------------
  // Sources

  private startCommand(source: Extract<Source, { kind: "command" }>) {
    let child: ChildProcess
    try {
      child = spawn(source.shell, ["-c", source.command], {
        cwd: source.cwd,
        env: { ...process.env, ...source.env },
        stdio: ["ignore", "pipe", "pipe"],
        // Own process group, so stopping kills the whole pipeline (`tail -f x | grep y`), not just the shell.
        detached: true,
      })
    } catch (error) {
      this.finish({ type: "error", message: errorMessage(error) })
      return
    }
    this.child = child

    const stdout = new LineSplitter((line) => {
      this.writeLog(line)
      this.emit(line)
    })
    const stderr = new LineSplitter((line) => {
      this.writeLog(`[stderr] ${line}`)
      const clean = cleanLine(line)
      if (clean.trim().length === 0) return
      this.stderrTail.push(truncate(clean, this.limits.maxEventBytes))
      if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift()
    })
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk))
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk))

    child.on("error", (error) => {
      // A failed spawn has no process and may never emit `close`.
      if (child.pid === undefined) {
        this.child = undefined
        this.resolveExited()
      }
      this.finish({ type: "error", message: errorMessage(error) })
    })
    // `close` fires after the process exits and its stdio is drained, so no output is lost.
    child.on("close", (code, signal) => {
      stdout.end()
      stderr.end()
      if (this.killTimer) clearTimeout(this.killTimer)
      this.child = undefined
      this.resolveExited()
      this.finish({ type: "exited", code, signal })
    })
  }

  private startSocket(source: Extract<Source, { kind: "ws" }>) {
    let socket: WebSocket
    try {
      socket = new WebSocket(source.url, source.protocols ? [...source.protocols] : undefined)
    } catch (error) {
      this.finish({ type: "error", message: errorMessage(error) })
      return
    }
    this.socket = socket
    socket.binaryType = "arraybuffer"
    let lastError: string | undefined

    socket.addEventListener("message", (event) => {
      const data = event.data
      const text =
        typeof data === "string"
          ? data
          : `[binary frame, ${data instanceof ArrayBuffer ? data.byteLength : (data as Blob).size} bytes]`
      this.writeLog(text)
      // One frame is one event, even when it spans several lines.
      this.emit(text, { multiline: true })
    })
    socket.addEventListener("error", (event) => {
      lastError = (event as ErrorEvent).message || "WebSocket error"
      this.writeLog(`[error] ${lastError}`)
    })
    socket.addEventListener("close", (event) => {
      this.socket = undefined
      this.resolveExited()
      this.finish({ type: "closed", code: event.code, reason: event.reason, error: lastError })
    })
  }

  // ---------------------------------------------------------------------------------------------
  // Events, batching, and rate limiting

  private emit(raw: string, options: { multiline?: boolean } = {}) {
    if (!this.running) return
    const text = options.multiline ? raw.split("\n").map(cleanLine).join("\n") : cleanLine(raw)
    if (text.trim().length === 0) return

    const event = truncate(text, this.limits.maxEventBytes)
    this.eventCount++
    this.lastEvent = event

    const bytes = Buffer.byteLength(event) + 1
    if (this.batch.length > 0 && this.batchBytes + bytes > this.limits.maxNotificationBytes) this.batchDropped++
    else {
      this.batch.push(event)
      this.batchBytes += bytes
    }
    this.batchTimer ??= setTimeout(() => this.flush(), this.limits.batchMs)
  }

  /** `final` is the flush made while ending; it skips the rate limit so it cannot re-enter `finish`. */
  private flush(final = false) {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = undefined
    if (this.batch.length === 0) return

    const notification: Notification = {
      seq: this.notificationCount + 1,
      events: this.batch,
      dropped: this.batchDropped,
    }
    this.batch = []
    this.batchBytes = 0
    this.batchDropped = 0

    if (!final) {
      const now = this.now()
      while (this.sentAt.length > 0 && now - this.sentAt[0]! >= this.limits.rateWindowMs) this.sentAt.shift()
      if (this.sentAt.length >= this.limits.maxNotificationsPerWindow) {
        this.finish({
          type: "rate-limited",
          notifications: this.sentAt.length,
          windowMs: this.limits.rateWindowMs,
        })
        return
      }
      this.sentAt.push(now)
    }

    this.notificationCount++
    this.handlers.onNotification(notification)
  }

  // ---------------------------------------------------------------------------------------------
  // Shutdown

  private finish(reason: EndReason) {
    if (this.endReason) return
    // A natural end (exit, close, timeout, error) delivers events already seen. An explicit stop,
    // a teardown, or a firehose discards them: nobody wants one more wake-up after those.
    if (reason.type === "stopped" || reason.type === "shutdown" || reason.type === "unloaded" || reason.type === "rate-limited")
      this.discardBatch()
    else this.flush(true)

    this.endReason = reason
    this.endedAt = this.now()
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer)
    this.timeoutTimer = undefined

    this.killSource()
    if (!this.child && !this.socket) this.resolveExited()
    this.writeLog(`[monitor] ended: ${reason.type}`)
    this.log?.end()
    this.log = undefined

    this.handlers.onEnd({
      reason,
      events: this.eventCount,
      notifications: this.notificationCount,
      durationMs: this.durationMs,
      stderrTail: [...this.stderrTail],
      lastEvent: this.lastEvent,
    })
  }

  private discardBatch() {
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = undefined
    this.batch = []
    this.batchBytes = 0
    this.batchDropped = 0
  }

  private killSource() {
    const child = this.child
    if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      signalGroup(child.pid, "SIGTERM")
      this.killTimer = setTimeout(() => signalGroup(child.pid!, "SIGKILL"), this.limits.killGraceMs)
      this.killTimer.unref?.()
    }
    const socket = this.socket
    if (socket && socket.readyState !== WebSocket.CLOSED && socket.readyState !== WebSocket.CLOSING) {
      try {
        socket.close(1000, "monitor stopped")
      } catch {}
    }
  }

  private writeLog(line: string) {
    this.log?.write(`${line}\n`)
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {}
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
