/**
 * Tools Command - Show active/available tools
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

export default function (pi: ExtensionAPI) {
  pi.registerCommand('tools', {
    description: 'List active and available tools',
    handler: async (_args, ctx) => {
      const active = pi.getActiveTools()
      const all = pi.getAllTools()

      const activeSet = new Set(active)
      const lines: string[] = []

      const toolTag = (tool: (typeof all)[number]) => {
        if (tool.sourceInfo.source === 'builtin') return ''
        if (tool.sourceInfo.source === 'sdk') return ctx.ui.theme.fg('dim', ' (sdk)')
        return ctx.ui.theme.fg('dim', ` (${tool.sourceInfo.scope})`)
      }

      lines.push(ctx.ui.theme.fg('accent', ctx.ui.theme.bold(`Active tools (${active.length}):`)))
      for (const tool of all) {
        if (activeSet.has(tool.name)) {
          lines.push(`  ${ctx.ui.theme.fg('success', '✓')} ${tool.name}${toolTag(tool)}`)
        }
      }

      const inactive = all.filter((t) => !activeSet.has(t.name))
      if (inactive.length > 0) {
        lines.push('')
        lines.push(ctx.ui.theme.fg('muted', `Inactive (${inactive.length}):`))
        for (const tool of inactive) {
          lines.push(`  ${ctx.ui.theme.fg('dim', '○')} ${tool.name}${toolTag(tool)}`)
        }
      }

      ctx.ui.notify(lines.join('\n'), 'info')
    },
  })
}
