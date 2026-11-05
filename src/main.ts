/**
 * copilot-monitor: Claude Code-style background monitors for GitHub Copilot CLI.
 *
 * Entry point of the extension. Copilot CLI forks this file (built to dist/extension.mjs) for the
 * foreground session; `joinSession` connects back over stdio. Copilot reloads extensions on /clear
 * and when the agent calls extensions_reload, and stops them on exit with SIGTERM, then SIGKILL
 * after 5 seconds. Monitors run in their own process groups, so they are stopped here first.
 *
 * stdout carries the JSON-RPC connection: never write to it. Diagnostics go to stderr.
 */
import { mkdirSync } from "node:fs"
import { joinSession } from "@github/copilot-sdk/extension"
import { loadConfig } from "./config.ts"
import { createExtension } from "./extension.ts"

const { config, warning } = loadConfig()
// Monitor output can be sensitive: keep the logs private to this user.
mkdirSync(config.logDir, { recursive: true, mode: 0o700 })

const extension = createExtension(config)
const session = await joinSession({ tools: extension.tools, commands: extension.commands })
extension.attach(session)
if (warning) void session.log(`copilot-monitor: ${warning}`, { level: "warning" })

let exiting = false
const exit = async () => {
  if (exiting) return
  exiting = true
  try {
    await extension.shutdown()
  } finally {
    process.exit(0)
  }
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => void exit())
// The CLI went away without signalling (crash, SIGKILL): the connection's input closes.
process.stdin.once("end", () => void exit())
process.stdin.once("close", () => void exit())
// Safety net for any other exit path: no monitor process outlives the extension.
process.once("exit", () => extension.killAll())
