const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")

const PI_AGENT_DIR = path.join(os.homedir(), ".pi", "agent")
const PROJECT_DIR = path.join(__dirname, "..")

const LINKS = ["extensions", "agents", "skills"]

fs.mkdirSync(PI_AGENT_DIR, { recursive: true })

for (const dir of LINKS) {
  const target = path.join(PROJECT_DIR, dir)
  const link = path.join(PI_AGENT_DIR, dir)

  if (!fs.existsSync(target)) {
    console.warn(`⚠ ${target} does not exist, skipping`)
    continue
  }

  if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
    const existing = fs.readlinkSync(link)
    if (path.resolve(PI_AGENT_DIR, existing) === target) {
      console.log(`✓ ${link} already points to ${target}`)
      continue
    }
    console.warn(`⚠ ${link} exists but points elsewhere (${existing}), skipping`)
    continue
  }

  fs.symlinkSync(target, link)
  console.log(`✓ ${link} → ${target}`)
}
