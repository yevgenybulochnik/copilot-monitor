/**
 * Settings, read from `$COPILOT_HOME/copilot-monitor.json` (default `~/.copilot/copilot-monitor.json`)
 * or from the file named by `COPILOT_MONITOR_CONFIG`. Every key is optional.
 *
 * Copilot CLI has no per-extension options, so the extension and the status line script both read
 * this file.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"

export interface Config {
  readonly shell: string
  /** Each monitor's full output, plus per-session state for the status line. */
  readonly logDir: string
  readonly defaultTimeoutMs: number
  readonly maxTimeoutMs: number
  readonly batchMs: number
  readonly maxNotificationsPerMinute: number
  readonly maxNotificationBytes: number
  readonly maxMonitorsPerSession: number
  /** `immediate` steers into a running turn; `enqueue` waits behind other pending messages. */
  readonly delivery: "immediate" | "enqueue"
  /**
   * Let monitor_stop and monitor_list run without a permission prompt. Copilot treats skipping
   * prompts as an elevated permission, which it asks for once per repository when the extension loads.
   */
  readonly autoApproveStopAndList: boolean
}

export function copilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(homedir(), ".copilot")
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_MONITOR_CONFIG || join(copilotHome(env), "copilot-monitor.json")
}

/** Reads the settings file. A missing file means defaults; a broken one is reported, then ignored. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): { config: Config; warning?: string } {
  const path = configPath(env)
  if (!existsSync(path)) return { config: readConfig({}) }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { config: readConfig({}), warning: `${path} must contain a JSON object; using defaults.` }
    }
    return { config: readConfig(parsed as Record<string, unknown>) }
  } catch (error) {
    return { config: readConfig({}), warning: `Could not read ${path} (${String(error)}); using defaults.` }
  }
}

export function readConfig(options: Readonly<Record<string, unknown>>): Config {
  const number = (key: string, fallback: number, min: number) => {
    const value = options[key]
    return typeof value === "number" && Number.isFinite(value) && value >= min ? value : fallback
  }
  const maxTimeoutMs = number("maxTimeoutMs", 30 * 60_000, 1000)
  return {
    shell: typeof options.shell === "string" && options.shell ? options.shell : defaultShell(),
    logDir: typeof options.logDir === "string" && options.logDir ? options.logDir : defaultLogDir(),
    defaultTimeoutMs: clamp(number("defaultTimeoutMs", 5 * 60_000, 1000), 1000, maxTimeoutMs),
    maxTimeoutMs,
    batchMs: number("batchMs", 200, 0),
    maxNotificationsPerMinute: number("maxNotificationsPerMinute", 30, 1),
    maxNotificationBytes: number("maxNotificationBytes", 8 * 1024, 256),
    maxMonitorsPerSession: number("maxMonitorsPerSession", 10, 1),
    delivery: options.delivery === "enqueue" ? "enqueue" : "immediate",
    autoApproveStopAndList: options.autoApproveStopAndList === true,
  }
}

/** Per-user, so another user on a shared machine cannot pre-create or read the directory. */
export function defaultLogDir(): string {
  return join(tmpdir(), `copilot-monitor-${process.getuid?.() ?? "user"}`)
}

/** The user's shell when it understands POSIX `-c` scripts, otherwise bash, otherwise sh. */
export function defaultShell(): string {
  const shell = process.env.SHELL
  if (shell && ["bash", "zsh", "sh", "dash", "ksh"].includes(basename(shell)) && existsSync(shell)) return shell
  for (const candidate of ["/bin/bash", "/usr/bin/bash"]) if (existsSync(candidate)) return candidate
  return "/bin/sh"
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}
