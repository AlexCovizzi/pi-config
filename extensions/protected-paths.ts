/**
 * Protected Paths Extension
 *
 * Blocks write/edit operations to protected paths.
 *
 * Protected paths: .env files, .git/ directory, ~/.ssh/, ~/.aws/, /etc/, etc.
 */

import { homedir } from 'node:os'
import { normalize, resolve, sep } from 'node:path'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  const home = homedir()

  const protectedFileNames = new Set(['.env', '.env.local', '.env.production'])

  const protectedDirNames = new Set(['.git'])

  const protectedAbsoluteDirs = ['/etc', '/root', '/usr/bin', '/usr/sbin'].map(normalize)

  const protectedHomeDirs = ['.ssh', '.aws'].map((d) => resolve(home, d))

  function expandHome(p: string): string {
    if (p.startsWith('~/')) return resolve(home, p.slice(2))
    if (p === '~') return home
    return p
  }

  function isProtectedPath(inputPath: string, cwd: string): boolean {
    const resolved = resolve(cwd, expandHome(inputPath))
    const segments = resolved.split(sep)

    const fileName = segments[segments.length - 1]

    // Allow .gitignore, .gitattributes, .gitmodules, etc. (not inside .git/ directory)
    if (/^\.git[a-z]/i.test(fileName)) return false

    // Exact filename match (e.g. ".env" won't match "my-env.ts")
    if (protectedFileNames.has(fileName)) return true

    // Directory name as a path segment (e.g. ".git" won't match "my-git-project")
    if (segments.some((s) => protectedDirNames.has(s))) return true

    // Absolute system paths
    if (protectedAbsoluteDirs.some((p) => resolved === p || resolved.startsWith(p + sep))) return true

    // Home subdirectories
    if (protectedHomeDirs.some((p) => resolved === p || resolved.startsWith(p + sep))) return true

    return false
  }

  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const inputPath = (event.input as Record<string, unknown>).path
      if (typeof inputPath !== 'string') return

      if (isProtectedPath(inputPath, ctx.cwd)) {
        return {
          block: true,
          reason: `Path "${inputPath}" is protected and cannot be modified.`,
        }
      }
    }
  })
}
