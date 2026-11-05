/**
 * Installs the built extension (run `bun run build` first, or use `bun run install-extension`).
 *
 *   bun scripts/install.ts                    user extension: links dist/ as
 *                                             $COPILOT_HOME/extensions/copilot-monitor (default ~/.copilot)
 *   bun scripts/install.ts --project <repo>   project extension: copies dist/extension.mjs to
 *                                             <repo>/.github/extensions/copilot-monitor/, to commit
 *   --force                                   replace whatever is at the target
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { copilotHome } from "../src/config.ts"

const args = process.argv.slice(2)
const force = args.includes("--force")
const projectIndex = args.indexOf("--project")
const dist = resolve(import.meta.dir, "..", "dist")

if (!existsSync(join(dist, "extension.mjs"))) {
  console.error(`No build found in ${dist}. Run \`bun run build\` first.`)
  process.exit(1)
}

if (projectIndex !== -1) {
  const repo = args[projectIndex + 1]
  if (!repo) {
    console.error("Usage: bun scripts/install.ts --project <repo>")
    process.exit(1)
  }
  const target = join(resolve(repo), ".github", "extensions", "copilot-monitor")
  mkdirSync(target, { recursive: true })
  const file = join(target, "extension.mjs")
  if (existsSync(file) && !force) {
    console.error(`${file} already exists. Pass --force to replace it.`)
    process.exit(1)
  }
  copyFileSync(join(dist, "extension.mjs"), file)
  console.log(`Copied the extension to ${file}. Commit it to share it with the repository.`)
} else {
  const extensions = join(copilotHome(), "extensions")
  const target = join(extensions, "copilot-monitor")
  mkdirSync(extensions, { recursive: true })
  const existing = lstatSync(target, { throwIfNoEntry: false })
  if (existing) {
    const ours = existing.isSymbolicLink() && resolve(extensions, readlinkSync(target)) === dist
    if (ours) {
      console.log(`${target} already links to ${dist}. Rebuilt files are picked up on the next session.`)
      process.exit(0)
    }
    if (!force) {
      console.error(`${target} already exists. Pass --force to replace it.`)
      process.exit(1)
    }
    rmSync(target, { recursive: true, force: true })
  }
  symlinkSync(dist, target, "dir")
  console.log(`Linked ${target} -> ${dist}`)
}

console.log(
  "Extensions are experimental in Copilot CLI: start it with `copilot --experimental` (or run /experimental on once).",
)
