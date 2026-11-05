import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MessageOptions, SessionEvent, ToolResultObject } from "@github/copilot-sdk/extension"
import { readConfig, type Config } from "../src/config.ts"
import { createExtension, type Extension } from "../src/extension.ts"
import { readRunning, stateFile } from "../src/state.ts"

let dir: string
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "copilot-monitor-ext-test-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** Records what the extension does to the session, and lets a test play the user. */
class FakeSession {
  readonly sessionId = `ses_${Math.random().toString(16).slice(2, 10)}`
  readonly workspacePath = undefined
  capabilities: { ui?: { elicitation?: boolean } } = { ui: { elicitation: true } }
  readonly sent: MessageOptions[] = []
  readonly logs: { message: string; level: string }[] = []
  readonly prompts: { message: string; options: string[] }[] = []
  /** Answers for the next `ui.select` calls; a function picks from the offered options. */
  readonly answers: (string | null | ((options: string[]) => string | null))[] = []
  processing = false
  failSends = false
  workingDirectory = dir
  private readonly handlers: ((event: SessionEvent) => void)[] = []

  readonly ui = {
    select: async (message: string, options: string[]) => {
      this.prompts.push({ message, options })
      const answer = this.answers.shift()
      return typeof answer === "function" ? answer(options) : (answer ?? null)
    },
    confirm: async () => false,
  }
  readonly rpc = {
    metadata: {
      snapshot: async () => ({ workingDirectory: this.workingDirectory }),
      isProcessing: async () => ({ processing: this.processing }),
    },
  }
  send = async (options: MessageOptions) => {
    if (this.failSends) throw new Error("session disconnected")
    this.sent.push(options)
    return `msg_${this.sent.length}`
  }
  log = async (message: string, options?: { level?: string }) => {
    this.logs.push({ message, level: options?.level ?? "info" })
  }
  on = (handler: (event: SessionEvent) => void) => {
    this.handlers.push(handler)
    return () => {}
  }
  emit(type: string, data: Record<string, unknown> = {}) {
    for (const handler of this.handlers) handler({ id: "evt", type, timestamp: new Date().toISOString(), data })
  }
  texts() {
    return this.sent.map((m) => m.prompt)
  }
}

const extensions: Extension[] = []
afterEach(async () => {
  for (const e of extensions.splice(0)) await e.shutdown()
})

function setup(overrides: Record<string, unknown> = {}) {
  const logDir = join(dir, `logs-${Math.random().toString(16).slice(2, 8)}`)
  mkdirSync(logDir, { recursive: true })
  const config: Config = readConfig({ shell: "/bin/bash", logDir, batchMs: 50, ...overrides })
  const extension = createExtension(config)
  const session = new FakeSession()
  extension.attach(session as never)
  extensions.push(extension)
  const tool = (name: string) => extension.tools.find((t) => t.name === name)!
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await tool(name).handler!(args, { sessionId: session.sessionId, toolCallId: "call_1", toolName: name, arguments: args })) as
      | string
      | ToolResultObject
  const command = async (args = "") =>
    extension.commands[0]!.handler({ sessionId: session.sessionId, command: `/monitors ${args}`, commandName: "monitors", args })
  return { extension, session, config, logDir, call, command }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(condition: () => boolean, timeoutMs = 5_000) {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time")
    await settle(20)
  }
}

const alive = (pattern: string) => {
  try {
    return execFileSync("pgrep", ["-f", "--", pattern], { encoding: "utf8" }).trim().length > 0
  } catch {
    return false
  }
}

const idOf = (result: string | ToolResultObject) => /Monitor (mon_[0-9a-f]{8}) started/.exec(String(result))![1]!

describe("monitor tool", () => {
  test("events and the exit notice arrive as system messages with a timeline summary", async () => {
    const { session, call } = setup()
    const result = await call("monitor", { command: "echo 'ERROR one'; sleep 0.3; echo 'ERROR two'", description: "errors" })
    expect(String(result)).toContain("started")
    await until(() => session.texts().some((t) => t.includes("<monitor-ended")))

    expect(session.sent.map((m) => [m.source, m.mode])).toEqual([
      ["system", "immediate"],
      ["system", "immediate"],
      ["system", "immediate"],
    ])
    expect(session.sent[0]!.prompt).toContain('<monitor-event monitor="')
    expect(session.sent[0]!.prompt).toContain("ERROR one")
    expect(session.sent[0]!.displayPrompt).toBe("◉ errors: ERROR one")
    expect(session.sent[1]!.displayPrompt).toBe("◉ errors: ERROR two")
    expect(session.sent[2]!.prompt).toContain('reason="exited"')
    expect(session.sent[2]!.displayPrompt).toBe("◉ errors exited · 2 events")
    // The TUI hides system messages, so the summary is logged too.
    expect(session.logs).toEqual([
      { message: "◉ errors: ERROR one", level: "info" },
      { message: "◉ errors: ERROR two", level: "info" },
      { message: "◉ errors exited · 2 events", level: "info" },
    ])
  })

  test("a failing command is logged as a warning, with its stderr in the notice", async () => {
    const { session, call } = setup()
    await call("monitor", { command: "echo 'fatal: boom' >&2; exit 3", description: "failing" })
    await until(() => session.sent.length === 1)
    expect(session.logs).toEqual([{ message: "◉ failing exited with code 3 · 0 events", level: "warning" }])
    expect(session.sent[0]!.prompt).toContain("fatal: boom")
  })

  test("the permission prompt stays short: guidance lives in the parameter descriptions", () => {
    const { extension } = setup()
    const tool = extension.tools.find((t) => t.name === "monitor")!
    expect(tool.description!.length).toBeLessThan(1_200)
    expect(tool.skipPermission).toBe(false)
    const properties = (tool.parameters as { properties: Record<string, { description: string }> }).properties
    expect(properties.command!.description).toContain("--line-buffered")
    expect(properties.command!.description).toContain("silence is not success")
    expect(properties.timeout_ms!.description).toContain("re-arm")
    for (const name of ["monitor_stop", "monitor_list"]) {
      expect(extension.tools.find((t) => t.name === name)!.skipPermission).toBe(false)
    }
    const { extension: trusting } = setup({ autoApproveStopAndList: true })
    expect(trusting.tools.find((t) => t.name === "monitor_list")!.skipPermission).toBe(true)
  })

  test("delivery: enqueue queues behind other messages", async () => {
    const { session, call } = setup({ delivery: "enqueue" })
    await call("monitor", { command: "echo hi", description: "hi" })
    await until(() => session.sent.length === 2)
    expect(session.sent.map((m) => m.mode)).toEqual(["enqueue", "enqueue"])
  })

  test("the command runs in the session's working directory, or workdir relative to it", async () => {
    const { session, call } = setup()
    mkdirSync(join(dir, "sub"), { recursive: true })
    await call("monitor", { command: "pwd; echo $COPILOT_MONITOR_ID", description: "where" })
    await call("monitor", { command: "pwd", description: "sub", workdir: "sub" })
    await until(() => session.texts().filter((t) => t.includes("<monitor-ended")).length === 2)
    const events = session.texts().filter((t) => t.includes("<monitor-event"))
    expect(events.some((t) => t.includes(`${dir}\n`) && /mon_[0-9a-f]{8}/.test(t))).toBe(true)
    expect(events.some((t) => t.includes(join(dir, "sub")))).toBe(true)
  })

  test("bad input fails without starting anything", async () => {
    const { extension, call } = setup()
    const failures = [
      await call("monitor", { command: "echo x" }),
      await call("monitor", { description: "neither" }),
      await call("monitor", { command: "echo x", ws: { url: "ws://x" }, description: "both" }),
      await call("monitor", { ws: { url: "not a url" }, description: "bad url" }),
      await call("monitor", { ws: { url: "https://example.com" }, description: "not ws" }),
      await call("monitor", { command: "echo x", description: "bad dir", workdir: "does/not/exist" }),
    ] as ToolResultObject[]
    for (const f of failures) expect(f.resultType).toBe("failure")
    expect(failures.map((f) => f.textResultForLlm)).toEqual([
      "Error: description is required.",
      "Error: pass exactly one of command or ws.",
      "Error: pass exactly one of command or ws.",
      "Error: invalid WebSocket URL: not a url",
      "Error: WebSocket URL must use ws:// or wss://, got https:",
      `Error: working directory does not exist: ${join(dir, "does/not/exist")}`,
    ])
    expect(extension.monitors.size).toBe(0)
  })

  test("the per-session limit counts running monitors", async () => {
    const { call } = setup({ maxMonitorsPerSession: 1 })
    await call("monitor", { command: "sleep 30", description: "one" })
    const second = (await call("monitor", { command: "sleep 30", description: "two" })) as ToolResultObject
    expect(second.resultType).toBe("failure")
    expect(second.textResultForLlm).toContain("already has 1 running monitors (limit 1)")
  })

  test("monitor_stop is silent and kills the command; monitor_list shows both states", async () => {
    const { session, call } = setup()
    const marker = `cp-ext-stop-${process.pid}-${Date.now()}`
    const id = idOf(await call("monitor", { command: `sleep 30 # ${marker}`, description: "sleeper" }))
    await call("monitor", { command: "echo done", description: "quick" })
    await until(() => session.texts().some((t) => t.includes('description="quick" reason="exited"')))
    expect(await call("monitor_stop", { id })).toContain(`Stopped monitor ${id} ("sleeper")`)
    expect(await call("monitor_stop", { id })).toBe(`Monitor ${id} already ended (stopped).`)
    expect(await call("monitor_stop", { id: "mon_nope" })).toContain("No monitor with ID mon_nope.")
    await settle(300)
    expect(alive(marker)).toBe(false)
    expect(session.texts().some((t) => t.includes(`monitor="${id}"`))).toBe(false)
    const list = String(await call("monitor_list"))
    expect(list).toContain(`${id}  [stopped]  "sleeper"`)
    expect(list).toContain(`[exited]  "quick"`)
  })

  test("a failed delivery stops the monitor", async () => {
    const { extension, session, call } = setup()
    session.failSends = true
    const id = idOf(await call("monitor", { command: "echo one; sleep 30", description: "doomed" }))
    await until(() => !extension.monitors.get(id)!.running)
    expect(extension.monitors.get(id)!.status).toBe("shutdown")
  })
})

describe("stops by the user", () => {
  test("from an idle session, the notice waits for the user's next message", async () => {
    const { session, call, command } = setup()
    const id = idOf(await call("monitor", { command: "sleep 30", description: "sleeper" }))
    await command(`stop ${id.slice(4, 8)}`) // a unique ID prefix is enough
    expect(session.logs.at(-1)!.message).toBe(`Stopped monitor ${id} ("sleeper") after 0 event(s).`)
    expect(session.sent).toHaveLength(0) // no wake-up

    session.emit("user.message", { content: "notice", source: "system" }) // one of ours: ignored
    expect(session.sent).toHaveLength(0)
    session.emit("user.message", { content: "what next?" })
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]!.mode).toBe("immediate")
    expect(session.sent[0]!.prompt).toContain("The user stopped this monitor with /monitors")
    expect(session.sent[0]!.displayPrompt).toBe("◉ Told Copilot that you stopped a monitor")
    session.emit("user.message", { content: "and again" })
    expect(session.sent).toHaveLength(1) // delivered once
  })

  test("the notice rides along with the next monitor tool result instead, if that comes first", async () => {
    const { session, call, command } = setup()
    const id = idOf(await call("monitor", { command: "sleep 30", description: "sleeper" }))
    await command(`stop ${id}`)
    const list = String(await call("monitor_list"))
    expect(list.startsWith(`<monitor-ended monitor="${id}"`)).toBe(true)
    session.emit("user.message", { content: "hi" })
    expect(session.sent).toHaveLength(0)
  })

  test("a failed tool call still carries the notice", async () => {
    const { call, command } = setup()
    const id = idOf(await call("monitor", { command: "sleep 30", description: "sleeper" }))
    await command(`stop ${id}`)
    const failed = (await call("monitor", { command: "echo x" })) as ToolResultObject
    expect(failed.resultType).toBe("failure")
    expect(failed.textResultForLlm).toContain("The user stopped this monitor")
    expect(failed.textResultForLlm.endsWith("Error: description is required.")).toBe(true)
    expect(String(await call("monitor_list"))).not.toContain("The user stopped")
  })

  test("with delivery: enqueue, a mid-turn stop notice is still steered, not queued as a new turn", async () => {
    const { session, call, command } = setup({ delivery: "enqueue" })
    const id = idOf(await call("monitor", { command: "sleep 30", description: "sleeper" }))
    session.emit("assistant.turn_start", { turnId: "t1" })
    await command(`stop ${id}`)
    await until(() => session.sent.length === 1)
    expect(session.sent[0]!.mode).toBe("immediate")
  })

  test("during a running turn, the notice is steered in right away", async () => {
    const { session, call, command } = setup()
    const id = idOf(await call("monitor", { command: "sleep 30", description: "sleeper" }))
    session.emit("assistant.turn_start", { turnId: "t1" })
    await command(`stop ${id}`)
    await until(() => session.sent.length === 1)
    expect(session.sent[0]!.prompt).toContain("The user stopped this monitor")
    expect(session.sent[0]!.displayPrompt).toBe("◉ sleeper was stopped by you · 0 events")
  })

  test("/monitors lists monitors and stops the one picked", async () => {
    const { extension, session, call, command } = setup()
    const sleeper = idOf(await call("monitor", { command: "sleep 30", description: "sleeper" }))
    const quick = idOf(await call("monitor", { command: "echo hi", description: "quick" }))
    await until(() => !extension.monitors.get(quick)!.running)
    session.answers.push(
      (options) => options.find((o) => o.includes(sleeper))!,
      "Stop this monitor",
    )
    await command()
    const [list, details] = session.prompts
    expect(list!.message).toBe("Monitors in this session: 1 running, 1 ended. Pick one for details.")
    expect(list!.options[0]).toMatch(new RegExp(`^● sleeper — 0 events · 5m left · ${sleeper}$`))
    expect(list!.options[1]).toMatch(new RegExp(`^○ quick — exited \\d+s ago · 1 event · ${quick}$`))
    expect(details!.message).toContain(`ID: ${sleeper}`)
    expect(details!.message).toContain("Source: sleep 30")
    expect(details!.options).toEqual(["Stop this monitor", "Back to the list"])
    expect(extension.monitors.get(sleeper)!.status).toBe("stopped")
  })

  test("/monitors without dialogs, and /monitors stop all", async () => {
    const { extension, session, call, command } = setup()
    session.capabilities = {}
    await call("monitor", { command: "sleep 30", description: "a" })
    await call("monitor", { command: "sleep 30", description: "b" })
    await command()
    expect(session.logs.at(-1)!.message).toContain('[running, expires in 5m]  "a"')
    await command("stop all")
    expect([...extension.monitors.values()].every((m) => !m.running)).toBe(true)
    await command("stop")
    expect(session.logs.at(-1)).toEqual({ message: "Usage: /monitors stop <id|all>", level: "warning" })
    await command("bogus")
    expect(session.logs.at(-1)!.message).toContain('Unknown subcommand "bogus"')
  })
})

describe("shutdown", () => {
  test("kills every process group; an idle session gets no notice", async () => {
    const { extension, session, call, logDir } = setup()
    const marker = `cp-ext-shutdown-${process.pid}-${Date.now()}`
    await call("monitor", { command: `tail -f /dev/null | cat # ${marker}`, description: "tail" })
    await settle(200)
    expect(alive(marker)).toBe(true)
    expect(existsSync(stateFile(logDir, session.sessionId))).toBe(true)
    await extension.shutdown()
    await settle(100)
    expect(alive(marker)).toBe(false)
    expect(session.sent).toHaveLength(0)
    expect(existsSync(stateFile(logDir, session.sessionId))).toBe(false)
  })

  test("a session mid-turn is told its monitors stopped", async () => {
    const { extension, session, call } = setup()
    await call("monitor", { command: "sleep 30", description: "sleeper" })
    session.processing = true
    await extension.shutdown()
    expect(session.sent).toHaveLength(1)
    expect(session.sent[0]!.prompt).toContain('reason="unloaded"')
  })
})

describe("status line", () => {
  test("the state file lists running monitors while its owner lives", async () => {
    const { session, call, logDir } = setup()
    const id = idOf(await call("monitor", { command: "sleep 30", description: "sleeper" }))
    expect(readRunning(logDir, session.sessionId).map((m) => m.id)).toEqual([id])
    writeFileSync(
      stateFile(logDir, "ses_dead"),
      JSON.stringify({ ownerPid: 2 ** 22 + 12345, updatedAt: 0, running: [{ id, description: "x", expiresAt: Date.now() + 1e6 }] }),
    )
    expect(readRunning(logDir, "ses_dead")).toEqual([])
    expect(readRunning(logDir, "ses_missing")).toEqual([])
  })

  test("the script prints the count, after any wrapped status line", async () => {
    const { session, call, logDir } = setup()
    await call("monitor", { command: "sleep 30", description: "a" })
    await call("monitor", { command: "sleep 30", description: "b" })
    const configFile = join(logDir, "config.json")
    writeFileSync(configFile, JSON.stringify({ logDir }))
    const run = (...args: string[]) =>
      spawnSync("bun", [join(import.meta.dir, "../src/statusline.ts"), ...args], {
        input: JSON.stringify({ session_id: session.sessionId, cwd: dir }),
        env: { ...process.env, COPILOT_MONITOR_CONFIG: configFile },
        encoding: "utf8",
      }).stdout
    expect(run()).toBe("◉ 2 monitors\n")
    expect(run("--", "echo", "main")).toBe("main  ◉ 2 monitors\n")
  })
})
