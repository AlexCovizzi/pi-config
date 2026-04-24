/**
 * Permission Gate Extension
 *
 * Asks the user for confirmation before running dangerous bash commands.
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'
import { isToolCallEventType } from '@mariozechner/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  const dangerousPatterns = [
    { pattern: /\bfind\b.*-delete\b/i, reason: 'Find with -delete flag' },
    { pattern: /\bsudo\b/i, reason: 'Sudo command' },
    { pattern: /\bmkfs\b/i, reason: 'Filesystem format command' },
    { pattern: /\bdd\b.*of=/i, reason: 'Low-level disk operation (dd)' },
    { pattern: /:\s*\(\s*\)\s*\{.*\|.*&/i, reason: 'Fork bomb pattern' },
    { pattern: /\b(shutdown|reboot)\b/i, reason: 'System shutdown/reboot' },
    { pattern: /\bkill\s+-9\s+-1\b/i, reason: 'Kill all processes' },
    {
      pattern: /\bchmod\b.*\b777\b/i,
      reason: 'Insecure file permissions (chmod 777)',
    },
    { pattern: /\bchown\b.*\b-R\b/i, reason: 'Recursive ownership change' },
    { pattern: />\s*\/(etc|usr)\//i, reason: 'Redirect to system path' },
    {
      pattern: /(?:curl|wget).*\|\s*(?:bash|sh|python|perl)/i,
      reason: 'Pipe to shell execution',
    },
    { pattern: /\bcrontab\s+-[ri]/i, reason: 'Crontab modification' },
    {
      pattern: /\b(userdel|groupdel)\b/i,
      reason: 'User/group deletion command',
    },
  ]

  function getDangerousReason(command: string): string | null {
    for (const { pattern, reason } of dangerousPatterns) {
      if (pattern.test(command)) return reason
    }

    // rm with both recursive and force flags (handles -rf, -r -f, --recursive --force, etc.)
    if (/\brm\b/i.test(command)) {
      const hasR = /-[a-zA-Z]*r|--recursive/i.test(command)
      const hasF = /-[a-zA-Z]*f|--force/i.test(command)
      if (hasR && hasF) return 'Recursive force remove (rm -rf)'
    }

    return null
  }

  pi.on('tool_call', async (event, ctx) => {
    if (!isToolCallEventType('bash', event)) return
    const command = event.input.command
    if (!command) return

    const reason = getDangerousReason(command)
    if (!reason) return

    if (!ctx.hasUI) {
      return { block: true, reason: `Dangerous command blocked: ${reason}` }
    }

    const allowed = await ctx.ui.confirm('⚠️ Dangerous Command', `${command}\n\nReason: ${reason}\n\nAllow execution?`)
    if (!allowed) {
      return { block: true, reason: `Blocked by user: ${reason}` }
    }
  })
}
