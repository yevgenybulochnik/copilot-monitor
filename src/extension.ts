/**
 * The extension's tools, its /monitors command, and delivery into the session.
 *
 * Kept apart from `joinSession` (main.ts) so tests can drive it with a fake session.
 *
 * Tools:
 *   monitor       start a command or WebSocket source; each stdout line / frame is an event
 *   monitor_stop  stop a monitor early
 *   monitor_list  list this session's monitors
 *
 * Each notification is sent with `session.send({ source: "system" })`. A message sent while the
 * session is idle starts a turn, so an event wakes the agent the way a Claude Code monitor does.
 * The TUI hides system messages, so each one is also logged to the timeline as a one-line summary,
 * which tells the user why the agent woke up.
 */
import { randomBytes } from "node:crypto"
import { existsSync, statSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type {
  CommandContext,
  CommandDefinition,
  CopilotSession,
  SessionEvent,
  Tool,
  ToolResultObject,
} from "@github/copilot-sdk/extension"
import { clamp, type Config } from "./config.ts"
import {
  commandDescription,
  listDescription,
  monitorDescription,
  stopDescription,
  timeoutDescription,
  wsDescription,
} from "./description.ts"
import * as format from "./format.ts"
import { Monitor, type Source, type Summary } from "./monitor.ts"
import { removeState, writeState } from "./state.ts"

interface MonitorInput {
  command?: string
  ws?: { url: string; protocols?: string[] }
  description?: string
  timeout_ms?: number
  workdir?: string
}

/** Ended monitors kept for monitor_list and /monitors. */
const KEEP_ENDED = 20
/** How long shutdown waits for processes to exit after SIGTERM before sending SIGKILL. */
const EXIT_GRACE_MS = 1_500
/** How long shutdown waits for final notices to reach the session. */
const DELIVERY_GRACE_MS = 1_000

export interface Extension {
  readonly tools: Tool<any>[]
  readonly commands: CommandDefinition[]
  /** Monitors by ID, oldest first. */
  readonly monitors: ReadonlyMap<string, Monitor>
  /** Binds to the joined session. Tools and commands are only called after this. */
  attach(session: CopilotSession): void
  /** Stops every monitor, waits briefly for their processes to exit, and clears the state file. */
  shutdown(): Promise<void>
  /** Last resort on process exit: SIGKILL whatever is still running, synchronously. */
  killAll(): void
}

export function createExtension(config: Config, options: { ownerPid?: number } = {}): Extension {
  const ownerPid = options.ownerPid ?? process.pid
  const monitors = new Map<string, Monitor>()
  const deliveries = new Map<string, Promise<void>>()
  /** "The user stopped this monitor" notices waiting for the agent's next turn. */
  const pending: string[] = []
  let session: CopilotSession | undefined
  /** Whether a turn is running, from session events. */
  let busy = false
  let closing = false
  /** Whether "unloaded" notices are worth sending: only into a running turn, never to wake one. */
  let announceUnload = false

  const attached = (): CopilotSession => {
    if (!session) throw new Error("copilot-monitor is not attached to a session yet")
    return session
  }

  /**
   * Sends one message into the session, in order per monitor, after logging its summary to the
   * timeline at `level` (`null`: no log).
   */
  const deliver = (
    monitor: Monitor,
    prompt: string,
    displayPrompt: string,
    options: { level?: "info" | "warning" | null; mode?: "immediate" | "enqueue" } = {},
  ) => {
    const level = options.level === undefined ? "info" : options.level
    const previous = deliveries.get(monitor.id) ?? Promise.resolve()
    const next = previous
      .then(async () => {
        const s = attached()
        if (level) await s.log(displayPrompt, { level }).catch(() => {})
        await s.send({ prompt, displayPrompt, source: "system", mode: options.mode ?? config.delivery })
      })
      .then(
        () => {},
        (error: unknown) => {
          // Most likely the session is gone. Stop rather than keep producing undeliverable events.
          console.error(`[copilot-monitor] delivery failed for ${monitor.id}:`, error)
          if (monitor.running) monitor.stop({ type: "shutdown" })
        },
      )
    deliveries.set(monitor.id, next)
  }

  /** Pending notices, removed from the queue, as text to put in front of the next message. */
  const takePending = (): string => {
    if (pending.length === 0) return ""
    return `${pending.splice(0).join("\n\n")}\n\n`
  }

  /** Wraps a tool handler so pending notices ride along with its result, success or failure. */
  const withNotices =
    <T>(handler: (input: T) => Promise<string | ToolResultObject>) =>
    async (input: T): Promise<string | ToolResultObject> => {
      const result = await handler(input)
      const notices = takePending()
      if (!notices) return result
      return typeof result === "string" ? notices + result : { ...result, textResultForLlm: notices + result.textResultForLlm }
    }

  /** Sends pending notices now, steering them into the turn that just started. */
  const flushPending = () => {
    if (pending.length === 0 || !session) return
    const count = pending.length
    const prompt = takePending().trimEnd()
    session
      .send({
        prompt,
        displayPrompt: `◉ Told Copilot that you stopped ${count === 1 ? "a monitor" : `${count} monitors`}`,
        source: "system",
        mode: "immediate",
      })
      .catch((error: unknown) => console.error("[copilot-monitor] could not deliver stop notice:", error))
  }

  const writeStatus = () => {
    if (!session) return
    const running = [...monitors.values()]
      .filter((m) => m.running)
      .map((m) => ({ id: m.id, description: m.description, expiresAt: m.startedAt + m.timeoutMs }))
    try {
      writeState(config.logDir, session.sessionId, { ownerPid, updatedAt: Date.now(), running })
    } catch (error) {
      console.error("[copilot-monitor] could not write state file:", error)
    }
  }

  const prune = () => {
    const ended = [...monitors.values()].filter((m) => !m.running)
    for (const m of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED))) {
      monitors.delete(m.id)
      deliveries.delete(m.id)
    }
  }

  const onEnd = (monitor: Monitor, summary: Summary) => {
    const text = format.ended(monitor, summary, config.maxTimeoutMs)
    const reason = summary.reason
    const display = format.displayEnded(monitor)
    if (reason.type === "stopped" && reason.by === "user") {
      // News for the agent, but not worth waking it for: steer into a running turn, or wait for the
      // next. /monitors already told the user.
      if (text && busy) deliver(monitor, text, display, { level: null, mode: "immediate" })
      else if (text) pending.push(text)
    } else if (reason.type === "unloaded") {
      if (text && announceUnload) deliver(monitor, text, display, { mode: "immediate" })
    } else if (text) {
      deliver(monitor, text, display, { level: format.endedUnexpectedly(monitor) ? "warning" : "info" })
    }
    if (!closing) {
      writeStatus()
      prune()
    }
  }

  const sessionDirectory = async (): Promise<string> => {
    try {
      const snapshot = await attached().rpc.metadata.snapshot()
      if (snapshot.workingDirectory) return snapshot.workingDirectory
    } catch {}
    return process.cwd()
  }

  const failure = (text: string): ToolResultObject => ({ textResultForLlm: `Error: ${text}`, resultType: "failure" })

  // -----------------------------------------------------------------------------------------------
  // Tools

  const limits = {
    defaultTimeoutMs: config.defaultTimeoutMs,
    maxTimeoutMs: config.maxTimeoutMs,
    batchMs: config.batchMs,
    maxNotificationsPerMinute: config.maxNotificationsPerMinute,
  }

  const monitorTool: Tool<MonitorInput> = {
    name: "monitor",
    description: monitorDescription(),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: commandDescription(limits) },
        ws: {
          type: "object",
          description: wsDescription(),
          properties: {
            url: { type: "string" },
            protocols: { type: "array", items: { type: "string", pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]+$" } },
          },
          required: ["url"],
          additionalProperties: false,
        },
        description: {
          type: "string",
          description: "Short human-readable description of what you are monitoring (shown in every notification).",
        },
        timeout_ms: {
          type: "number",
          minimum: 1000,
          maximum: config.maxTimeoutMs,
          default: config.defaultTimeoutMs,
          description: timeoutDescription(limits),
        },
        workdir: {
          type: "string",
          description: "Working directory for command, absolute or relative to the session directory. Use this instead of cd.",
        },
      },
      required: ["description"],
      additionalProperties: false,
    },
    // Copilot asks before each call, showing the arguments, unless the user allowed the tool.
    skipPermission: false,
    defer: "never",
    handler: withNotices(async (input: MonitorInput) => {
      const description = input.description?.trim()
      if (!description) return failure("description is required.")
      if (Boolean(input.command?.trim()) === Boolean(input.ws)) return failure("pass exactly one of command or ws.")

      const running = [...monitors.values()].filter((m) => m.running)
      if (running.length >= config.maxMonitorsPerSession) {
        return failure(
          `this session already has ${running.length} running monitors (limit ${config.maxMonitorsPerSession}). ` +
            `Stop one with monitor_stop first.\n\n${format.listing(running)}`,
        )
      }

      const id = `mon_${randomBytes(4).toString("hex")}`
      let source: Source
      if (input.ws) {
        let url: URL
        try {
          url = new URL(input.ws.url)
        } catch {
          return failure(`invalid WebSocket URL: ${input.ws.url}`)
        }
        if (url.protocol !== "ws:" && url.protocol !== "wss:") {
          return failure(`WebSocket URL must use ws:// or wss://, got ${url.protocol}`)
        }
        source = { kind: "ws", url: url.toString(), protocols: input.ws.protocols }
      } else {
        const base = await sessionDirectory()
        const cwd = input.workdir ? (isAbsolute(input.workdir) ? input.workdir : resolve(base, input.workdir)) : base
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return failure(`working directory does not exist: ${cwd}`)
        source = { kind: "command", command: input.command!, cwd, shell: config.shell, env: { COPILOT_MONITOR_ID: id } }
      }

      const timeoutMs = clamp(input.timeout_ms ?? config.defaultTimeoutMs, 1000, config.maxTimeoutMs)
      const logFile = join(config.logDir, `${id}.log`)
      const monitor: Monitor = new Monitor({
        id,
        sessionId: attached().sessionId,
        description,
        source,
        timeoutMs,
        logFile,
        limits: {
          batchMs: config.batchMs,
          maxNotificationBytes: config.maxNotificationBytes,
          maxNotificationsPerWindow: config.maxNotificationsPerMinute,
          rateWindowMs: 60_000,
        },
        handlers: {
          onNotification: (note) => {
            deliver(monitor, takePending() + format.notification(monitor, note), format.displayEvent(monitor, note))
            writeStatus()
          },
          onEnd: (summary) => onEnd(monitor, summary),
        },
      })
      monitors.set(id, monitor)
      monitor.start()
      writeStatus()

      return (
        `Monitor ${id} started: "${description}"\n` +
        `Source: ${format.source(monitor)}\n` +
        (source.kind === "command" ? `Working directory: ${source.cwd}\n` : "") +
        `Expires in ${format.duration(timeoutMs)}. Events arrive as <monitor-event monitor="${id}"> messages; keep working.\n` +
        `Full output, including stderr: ${logFile}\n` +
        `Stop early with monitor_stop (id "${id}").`
      )
    }),
  }

  const stopTool: Tool<{ id: string }> = {
    name: "monitor_stop",
    description: stopDescription,
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The monitor ID, for example mon_1a2b3c4d." } },
      required: ["id"],
      additionalProperties: false,
    },
    skipPermission: config.autoApproveStopAndList,
    defer: "never",
    handler: withNotices(async ({ id }: { id: string }) => {
      const monitor = monitors.get(id)
      if (!monitor) return `No monitor with ID ${id}.\n\n${format.listing([...monitors.values()])}`
      if (!monitor.running) return `Monitor ${id} already ended (${monitor.status}).`
      monitor.stop({ type: "stopped", by: "agent" })
      return `Stopped monitor ${id} ("${monitor.description}") after ${monitor.events} event(s) in ${format.duration(monitor.durationMs)}.`
    }),
  }

  const listTool: Tool<Record<string, never>> = {
    name: "monitor_list",
    description: listDescription,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    skipPermission: config.autoApproveStopAndList,
    defer: "never",
    handler: withNotices(async () => format.listing([...monitors.values()])),
  }

  // -----------------------------------------------------------------------------------------------
  // /monitors

  /** Stops a monitor on the user's behalf; the agent hears about it at its next turn. */
  const stopForUser = async (monitor: Monitor) => {
    const s = attached()
    if (!monitor.running) {
      await s.log(`Monitor ${monitor.id} already ended (${format.endedHow(monitor)}).`)
      return
    }
    monitor.stop({ type: "stopped", by: "user" })
    await s.log(`Stopped monitor ${monitor.id} ("${monitor.description}") after ${monitor.events} event(s).`)
  }

  const sorted = () =>
    [...monitors.values()].sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt - a.startedAt)

  const label = (m: Monitor, now: number) => {
    const events = `${m.events} event${m.events === 1 ? "" : "s"}`
    if (m.running) return `● ${m.description} — ${events} · ${format.duration(Math.max(0, m.startedAt + m.timeoutMs - now))} left · ${m.id}`
    const ago = m.endedTime ? ` ${format.duration(now - m.endedTime)} ago` : ""
    return `○ ${m.description} — ${format.endedHow(m)}${ago} · ${events} · ${m.id}`
  }

  const details = (m: Monitor, now: number) =>
    [
      `${m.description}`,
      `ID: ${m.id}`,
      `Status: ${m.running ? `running, expires in ${format.duration(Math.max(0, m.startedAt + m.timeoutMs - now))}` : format.endedHow(m)}`,
      `Source: ${format.source(m)}`,
      `Events: ${m.events} in ${m.notifications} notification(s)`,
      `Started: ${format.duration(now - m.startedAt)} ago`,
      `Log: ${m.logFile}`,
    ].join("\n")

  /** Finds a monitor by ID or by a unique ID prefix (with or without `mon_`). */
  const find = (text: string): Monitor | undefined => {
    const key = text.trim()
    if (!key) return undefined
    const exact = monitors.get(key) ?? monitors.get(`mon_${key}`)
    if (exact) return exact
    const matches = [...monitors.values()].filter((m) => m.id.startsWith(key) || m.id.startsWith(`mon_${key}`))
    return matches.length === 1 ? matches[0] : undefined
  }

  const interactive = async () => {
    const s = attached()
    for (;;) {
      const list = sorted()
      if (list.length === 0) {
        await s.log("No monitors in this session.")
        return
      }
      const now = Date.now()
      const labels = list.map((m) => label(m, now))
      const runningCount = list.filter((m) => m.running).length
      const choice = await s.ui.select(
        `Monitors in this session: ${runningCount} running, ${list.length - runningCount} ended. Pick one for details.`,
        labels,
      )
      if (choice === null) return
      // The dialog also accepts typed text; treat it as a monitor ID.
      const monitor = list[labels.indexOf(choice)] ?? find(choice)
      if (!monitor) {
        await s.log(`No monitor matches "${choice}".`, { level: "warning" })
        return
      }
      const actions = monitor.running ? ["Stop this monitor", "Back to the list"] : ["Back to the list"]
      const action = await s.ui.select(details(monitor, Date.now()), actions)
      if (action === "Stop this monitor") {
        await stopForUser(monitor)
        return
      }
      if (action !== "Back to the list") return
    }
  }

  const monitorsCommand: CommandDefinition = {
    name: "monitors",
    description: "List this session's background monitors and stop one (/monitors stop <id|all>)",
    handler: async (context: CommandContext) => {
      const s = attached()
      const [verb = "", ...rest] = context.args.trim().split(/\s+/).filter(Boolean)
      const arg = rest.join(" ")
      try {
        if (verb === "stop") {
          if (arg === "all") {
            const running = [...monitors.values()].filter((m) => m.running)
            if (running.length === 0) await s.log("No running monitors.")
            for (const m of running) await stopForUser(m)
            return
          }
          const monitor = find(arg)
          if (!monitor) await s.log(arg ? `No monitor matches "${arg}".` : "Usage: /monitors stop <id|all>", { level: "warning" })
          else await stopForUser(monitor)
          return
        }
        if (verb && verb !== "list") {
          await s.log(`Unknown subcommand "${verb}". Usage: /monitors, /monitors list, /monitors stop <id|all>`, {
            level: "warning",
          })
          return
        }
        if (verb === "list" || !s.capabilities.ui?.elicitation) {
          await s.log(format.listing(sorted()))
          return
        }
        await interactive()
      } catch (error) {
        await s.log(`/monitors failed: ${String(error)}`, { level: "error" })
      }
    },
  }

  // -----------------------------------------------------------------------------------------------
  // Lifecycle

  const onEvent = (event: SessionEvent) => {
    switch (event.type) {
      case "assistant.turn_start":
        busy = true
        break
      case "session.idle":
        busy = false
        break
      case "user.message": {
        busy = true
        // A message the user typed (not one of ours, not another agent's) starts a turn: steer the
        // pending stop notices into it.
        const source = event.data.source
        if (!event.agentId && (source === undefined || source === "user")) flushPending()
        break
      }
    }
  }

  const running = () => [...monitors.values()].filter((m) => m.running)

  return {
    tools: [monitorTool, stopTool, listTool],
    commands: [monitorsCommand],
    monitors,

    attach(s) {
      session = s
      s.on(onEvent)
      writeStatus()
    },

    async shutdown() {
      if (closing) return
      closing = true
      const live = running()
      if (live.length > 0 && session) {
        // Tell the agent only if it is mid-turn (it reloaded extensions, say). An idle session is
        // being closed or replaced; a notice would start a turn nobody asked for.
        try {
          announceUnload = (await withTimeout(session.rpc.metadata.isProcessing(), 500)).processing
        } catch {
          announceUnload = busy
        }
      }
      for (const m of live) m.stop({ type: "unloaded" })
      await withTimeout(Promise.all(live.map((m) => m.exited)), EXIT_GRACE_MS).catch(() => {})
      for (const m of live) m.forceKill()
      await withTimeout(Promise.allSettled([...deliveries.values()]), DELIVERY_GRACE_MS).catch(() => {})
      if (session) removeState(config.logDir, session.sessionId)
    },

    killAll() {
      closing = true
      for (const m of running()) m.stop({ type: "unloaded" })
      for (const m of monitors.values()) m.forceKill()
      try {
        if (session) removeState(config.logDir, session.sessionId)
      } catch {}
    },
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    timer.unref?.()
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}
