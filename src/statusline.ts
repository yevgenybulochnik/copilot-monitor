/**
 * Status line command for Copilot CLI: prints "◉ 2 monitors" while the session has running
 * monitors, and nothing otherwise.
 *
 * Copilot runs the command with the session status as JSON on stdin. Configure it in
 * ~/.copilot/settings.json:
 *
 *   "statusLine": { "type": "command", "command": "node ~/.copilot/extensions/copilot-monitor/statusline.mjs", "refreshInterval": 5 }
 *
 * To keep an existing status line, pass its command after `--`; its output is printed first:
 *
 *   "command": "node ~/.copilot/extensions/copilot-monitor/statusline.mjs -- ~/bin/my-status.sh"
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { loadConfig } from "./config.ts"
import { readRunning } from "./state.ts"

const input = readStdin()
const parts: string[] = []

// Everything after the script is the wrapped command; a leading `--` is optional.
const args = process.argv.slice(2)
const wrapped = args[0] === "--" ? args.slice(1) : args
if (wrapped.length > 0) {
  const result = spawnSync(wrapped.join(" "), { shell: true, input, encoding: "utf8", timeout: 5_000 })
  const text = result.stdout?.replace(/\n+$/, "")
  if (text) parts.push(text)
}

let sessionId: string | undefined
try {
  sessionId = (JSON.parse(input) as { session_id?: string }).session_id ?? undefined
} catch {}

if (sessionId) {
  const count = readRunning(loadConfig().config.logDir, sessionId).length
  if (count > 0) parts.push(`◉ ${count} monitor${count === 1 ? "" : "s"}`)
}

if (parts.length > 0) process.stdout.write(`${parts.join("  ")}\n`)

function readStdin(): string {
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}
