/**
 * Agent Runner - Shared infrastructure for spawning pi subagent processes.
 *
 * Provides:
 *   - Agent loading from .md files
 *   - JSON-mode streaming with live onUpdate callbacks
 *   - Usage stats tracking and formatting
 *   - Tool call formatting for TUI rendering
 *   - TUI renderCall/renderResult helpers
 *
 * Used by per-agent tool extensions (explore, plan, refactor, etc.).
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { Message } from '@mariozechner/pi-ai'
import type { ExtensionAPI, ThemeColor } from '@mariozechner/pi-coding-agent'
import { getAgentDir, parseFrontmatter, withFileMutationQueue } from '@mariozechner/pi-coding-agent'
import { Container, Spacer, Text } from '@mariozechner/pi-tui'
import { Type } from '@sinclair/typebox'

// =============================================================================
// Types
// =============================================================================

export interface AgentConfig {
  name: string
  description: string
  tools?: string[]
  model?: string
  systemPrompt: string
  source: 'user' | 'project'
  filePath: string
}

export interface AgentRunOptions {
  /** Working directory for the spawned process */
  cwd: string
  /** Tools the agent should have access to (overrides agent config) */
  tools?: string[]
  /** Override the agent's default model */
  model?: string
  /** Abort signal for cancellation */
  signal?: AbortSignal
  /** Tools to exclude from the agent's tool list (e.g. to prevent recursion) */
  excludeTools?: string[]
}

export interface UsageStats {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
  turns: number
}

export interface AgentRunResult {
  agent: string
  agentSource: 'user' | 'project' | 'unknown'
  task: string
  exitCode: number
  messages: Message[]
  stderr: string
  usage: UsageStats
  model?: string
  stopReason?: string
  errorMessage?: string
}

export type DisplayItem =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; name: string; args: Record<string, unknown> }
  | { type: 'toolResult'; toolName: string; content: string }

// =============================================================================
// Agent loading
// =============================================================================

function loadAgentsFromDir(dir: string, source: 'user' | 'project'): AgentConfig[] {
  const agents: AgentConfig[] = []
  if (!fs.existsSync(dir)) return agents

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return agents
  }

  for (const entry of entries) {
    if (!entry.name.endsWith('.md')) continue
    if (!entry.isFile() && !entry.isSymbolicLink()) continue

    const filePath = path.join(dir, entry.name)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf-8')
    } catch {
      continue
    }

    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content)
    if (!frontmatter.name || !frontmatter.description) continue

    const tools = frontmatter.tools
      ?.split(',')
      .map((t: string) => t.trim())
      .filter(Boolean)

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body,
      source,
      filePath,
    })
  }

  return agents
}

/** Load a single named agent from the user agents directory */
export function loadAgent(agentName: string): AgentConfig | null {
  const userDir = path.join(getAgentDir(), 'agents')
  const agents = loadAgentsFromDir(userDir, 'user')
  return agents.find((a) => a.name === agentName) ?? null
}

/** Load all available agents from user and project directories */
export function loadAllAgents(cwd: string): AgentConfig[] {
  const userDir = path.join(getAgentDir(), 'agents')
  const projectDir = path.join(cwd, '.pi', 'agents')
  return [...loadAgentsFromDir(userDir, 'user'), ...loadAgentsFromDir(projectDir, 'project')]
}

// =============================================================================
// Formatting helpers
// =============================================================================

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  return `${(count / 1000000).toFixed(1)}M`
}

export function formatUsageStats(
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    cost: number
    contextTokens?: number
    turns?: number
  },
  model?: string
): string {
  const parts: string[] = []
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? 's' : ''}`)
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`)
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`)
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`)
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`)
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`)
  if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`)
  if (model) parts.push(model)
  return parts.join(' ')
}

const shortenPath = (p: string): string => {
  const home = os.homedir()
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p
}

export function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: ThemeColor, text: string) => string
): string {
  switch (toolName) {
    case 'bash': {
      const command = (args.command as string) || '...'
      const preview = command.length > 200 ? `${command.slice(0, 200)}...` : command
      return themeFg('muted', '$ ') + themeFg('toolOutput', preview)
    }
    case 'read': {
      const rawPath = (args.file_path || args.path || '...') as string
      const filePath = shortenPath(rawPath)
      const offset = args.offset as number | undefined
      const limit = args.limit as number | undefined
      let text = themeFg('accent', filePath)
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1
        const endLine = limit !== undefined ? startLine + limit - 1 : ''
        text += themeFg('warning', `:${startLine}${endLine ? `-${endLine}` : ''}`)
      }
      return themeFg('muted', 'read ') + text
    }
    case 'write': {
      const rawPath = (args.file_path || args.path || '...') as string
      const content = (args.content || '') as string
      const lines = content.split('\n').length
      let text = themeFg('muted', 'write ') + themeFg('accent', shortenPath(rawPath))
      if (lines > 1) text += themeFg('dim', ` (${lines} lines)`)
      return text
    }
    case 'edit': {
      const rawPath = (args.file_path || args.path || '...') as string
      return themeFg('muted', 'edit ') + themeFg('accent', shortenPath(rawPath))
    }
    case 'ls': {
      const rawPath = (args.path || '.') as string
      return themeFg('muted', 'ls ') + themeFg('accent', shortenPath(rawPath))
    }
    case 'find': {
      const pattern = (args.pattern || '*') as string
      const rawPath = (args.path || '.') as string
      return themeFg('muted', 'find ') + themeFg('accent', pattern) + themeFg('dim', ` in ${shortenPath(rawPath)}`)
    }
    case 'grep': {
      const pattern = (args.pattern || '') as string
      const rawPath = (args.path || '.') as string
      return (
        themeFg('muted', 'grep ') + themeFg('accent', `/${pattern}/`) + themeFg('dim', ` in ${shortenPath(rawPath)}`)
      )
    }
    default: {
      const argsStr = JSON.stringify(args)
      const preview = argsStr.length > 120 ? `${argsStr.slice(0, 120)}...` : argsStr
      return themeFg('accent', toolName) + themeFg('dim', ` ${preview}`)
    }
  }
}

// =============================================================================
// Core helpers
// =============================================================================

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') return part.text
      }
    }
  }
  return ''
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = []
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const part of msg.content) {
        if (part.type === 'text') items.push({ type: 'text', text: part.text })
        else if (part.type === 'toolCall') items.push({ type: 'toolCall', name: part.name, args: part.arguments })
      }
    } else if (msg.role === 'toolResult') {
      const textParts = msg.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
      items.push({ type: 'toolResult', toolName: msg.toolName, content: textParts })
    }
  }
  return items
}

export function aggregateUsage(results: AgentRunResult[]): UsageStats {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 }
  for (const r of results) {
    total.input += r.usage.input
    total.output += r.usage.output
    total.cacheRead += r.usage.cacheRead
    total.cacheWrite += r.usage.cacheWrite
    total.cost += r.usage.cost
    total.turns += r.usage.turns
    total.contextTokens = r.usage.contextTokens
  }
  return total
}

// =============================================================================
// Agent execution
// =============================================================================

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), `pi-agent-${agentName}-`))
  const safeName = agentName.replace(/[^\w.-]+/g, '_')
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`)
  await withFileMutationQueue(filePath, async () => {
    await fsPromises.writeFile(filePath, prompt, { encoding: 'utf-8', mode: 0o600 })
  })
  return { dir: tmpDir, filePath }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1]
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: 'pi', args }
}

/**
 * Run an agent as a child pi process with JSON-mode streaming.
 *
 * @param agent - The agent configuration to run
 * @param task - The task/prompt to send to the agent
 * @param options - Execution options (cwd, tools, model, signal)
 * @param onUpdate - Optional callback for streaming progress updates
 * @returns The full agent result with messages, usage, etc.
 */
export async function runAgent(
  agent: AgentConfig,
  task: string,
  options: AgentRunOptions,
  onUpdate?: (partial: { content: Array<{ type: 'text'; text: string }>; details: AgentRunResult }) => void
): Promise<AgentRunResult> {
  const excludeTools = new Set(options.excludeTools ?? [])
  const args: string[] = ['--mode', 'json', '-p', '--no-session']

  // Tools: use provided or agent config, filter excluded
  const toolList = options.tools ?? agent.tools ?? ['read', 'grep', 'find', 'ls', 'bash']
  const filtered = toolList.filter((t) => !excludeTools.has(t))
  args.push('--tools', filtered.join(','))

  // Model override
  const effectiveModel = options.model ?? agent.model
  if (effectiveModel) args.push('--model', effectiveModel)

  // System prompt via temp file
  let tmpPromptDir: string | null = null
  let tmpPromptPath: string | null = null

  const currentResult: AgentRunResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: '',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    model: effectiveModel,
  }

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: 'text', text: getFinalOutput(currentResult.messages) || '(running...)' }],
        details: { ...currentResult },
      })
    }
  }

  try {
    if (agent.systemPrompt.trim()) {
      const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt)
      tmpPromptDir = tmp.dir
      tmpPromptPath = tmp.filePath
      args.push('--append-system-prompt', tmpPromptPath)
    }

    args.push(`Task: ${task}`)
    let wasAborted = false

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args)
      const proc = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let buffer = ''

      const processLine = (line: string) => {
        if (!line.trim()) return
        let event: Record<string, unknown>
        try {
          event = JSON.parse(line) as Record<string, unknown>
        } catch {
          return
        }

        if (event.type === 'message_end' && event.message) {
          const msg = event.message as Message
          currentResult.messages.push(msg)

          if (msg.role === 'assistant') {
            currentResult.usage.turns++
            const usage = msg.usage
            if (usage) {
              currentResult.usage.input += usage.input || 0
              currentResult.usage.output += usage.output || 0
              currentResult.usage.cacheRead += usage.cacheRead || 0
              currentResult.usage.cacheWrite += usage.cacheWrite || 0
              currentResult.usage.cost += (usage.cost as { total?: number } | undefined)?.total || 0
              currentResult.usage.contextTokens = usage.totalTokens || 0
            }
            if (!currentResult.model && msg.model) currentResult.model = msg.model
            if (msg.stopReason) currentResult.stopReason = msg.stopReason as string | undefined
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage as string | undefined
          }
          emitUpdate()
        }

        if (event.type === 'tool_result_end' && event.message) {
          currentResult.messages.push(event.message as Message)
          emitUpdate()
        }
      }

      proc.stdout.on('data', (data: Buffer) => {
        buffer += data.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''
        for (const line of lines) processLine(line)
      })

      proc.stderr.on('data', (data: Buffer) => {
        currentResult.stderr += data.toString()
      })

      proc.on('close', (code) => {
        if (buffer.trim()) processLine(buffer)
        resolve(code ?? 0)
      })

      proc.on('error', () => {
        resolve(1)
      })

      if (options.signal) {
        const killProc = () => {
          wasAborted = true
          proc.kill('SIGTERM')
          setTimeout(() => {
            if (!proc.killed) proc.kill('SIGKILL')
          }, 5000)
        }
        if (options.signal.aborted) killProc()
        else options.signal.addEventListener('abort', killProc, { once: true })
      }
    })

    currentResult.exitCode = exitCode
    if (wasAborted) throw new Error('Agent was aborted')
    return currentResult
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath)
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir)
      } catch {
        /* ignore */
      }
  }
}

// =============================================================================
// TUI rendering helpers
// =============================================================================

export function renderAgentResult(
  result: AgentRunResult,
  expanded: boolean,
  theme: import('@mariozechner/pi-coding-agent').Theme
): import('@mariozechner/pi-tui').Component {
  const isError = result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted'
  const icon = isError ? theme.fg('error', '✗') : theme.fg('success', '✓')
  const displayItems = getDisplayItems(result.messages)

  // Extract tool call names in order
  const toolCallNames: string[] = []
  const toolCallDetails: Array<{ name: string; args: Record<string, unknown> }> = []
  for (const item of displayItems) {
    if (item.type === 'toolCall') {
      toolCallNames.push(item.name)
      toolCallDetails.push({ name: item.name, args: item.args })
    }
  }

  const statsLine = formatUsageStats(result.usage, result.model)
  const header = `${icon} ${theme.fg('toolTitle', theme.bold(result.agent))}${theme.fg('muted', ` (${result.agentSource})`)}`

  if (expanded) {
    const container = new Container()
    let headerText = header
    if (isError && result.stopReason) headerText += ` ${theme.fg('error', `[${result.stopReason}]`)}`
    container.addChild(new Text(headerText, 0, 0))
    if (isError && result.errorMessage)
      container.addChild(new Text(theme.fg('error', `Error: ${result.errorMessage}`), 0, 0))

    // Tool calls with args (no output)
    if (toolCallDetails.length > 0) {
      container.addChild(new Spacer(1))
      for (const { name, args } of toolCallDetails) {
        container.addChild(new Text(theme.fg('muted', '→ ') + formatToolCall(name, args, theme.fg.bind(theme)), 0, 0))
      }
    }

    // Stats
    if (statsLine) {
      container.addChild(new Spacer(1))
      container.addChild(new Text(theme.fg('dim', statsLine), 0, 0))
    }
    return container
  }

  // Collapsed — compact tool call names + stats
  let text = header
  if (isError && result.stopReason) text += ` ${theme.fg('error', `[${result.stopReason}]`)}`
  if (isError && result.errorMessage) {
    text += `\n${theme.fg('error', `Error: ${result.errorMessage}`)}`
  }

  if (toolCallNames.length > 0) {
    text += `\n${theme.fg('muted', toolCallNames.join(' → '))}`
  }

  if (statsLine) text += `\n${theme.fg('dim', statsLine)}`

  return new Text(text, 0, 0)
}

// =============================================================================
// agent tool + /agent command
// =============================================================================

export default function (pi: ExtensionAPI) {
  // ── agent tool ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'agent',
    label: 'Agent',
    description: 'Run a named subagent with a task. Discovers agents from ~/.pi/agent/agents/ and .pi/agents/.',
    promptSnippet: 'Delegate a task to a specialized subagent by name',
    promptGuidelines: [
      'Use this tool when the user explicitly asks to run a specific agent by name.',
      'Prefer the specialized tools (explore, plan, etc.) when the task matches their purpose.',
    ],
    parameters: Type.Object({
      name: Type.String({ description: 'Agent name (e.g. "explorer", "planner", "refactorer")' }),
      task: Type.String({ description: 'Task description to send to the agent' }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agents = loadAllAgents(ctx.cwd)
      const agent = agents.find((a) => a.name === params.name)
      if (!agent) {
        const available = agents.length > 0 ? ` Available: ${agents.map((a) => a.name).join(', ')}` : ''
        return {
          content: [{ type: 'text', text: `Agent "${params.name}" not found.${available}` }],
          details: {} as AgentRunResult,
          isError: true,
        }
      }

      const result = await runAgent(
        agent,
        params.task,
        {
          cwd: ctx.cwd,
          signal,
          excludeTools: ['explore', 'plan', 'agent'],
        },
        onUpdate
          ? (partial) => {
              onUpdate({ content: partial.content, details: partial.details })
            }
          : undefined
      )

      if (result.exitCode !== 0 || (!getFinalOutput(result.messages) && !result.stderr)) {
        const errorMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || '(no output)'
        return {
          content: [{ type: 'text', text: `${agent.name} failed: ${errorMsg}` }],
          details: result,
          isError: true,
        }
      }

      return {
        content: [{ type: 'text', text: getFinalOutput(result.messages) || '(no output)' }],
        details: result,
      }
    },

    renderCall(args, theme, _context) {
      const name = args.name || '...'
      const task = args.task || '...'
      const preview = task.length > 80 ? `${task.slice(0, 80)}...` : task
      return new Text(
        theme.fg('toolTitle', theme.bold('agent ')) + theme.fg('accent', name) + theme.fg('dim', `: ${preview}`),
        0,
        0
      )
    },

    renderResult(result, { expanded }, theme, _context) {
      const details = result.details as AgentRunResult | undefined
      if (!details?.agent) {
        const text = result.content[0]
        return new Text(text?.type === 'text' ? text.text : '(no output)', 0, 0)
      }
      return renderAgentResult(details, expanded, theme)
    },
  })

  // ── /agent command ──────────────────────────────────────────────────────────

  pi.registerCommand('agent', {
    description: 'Run a subagent interactively',
    getArgumentCompletions(prefix: string) {
      const agents = loadAllAgents(process.cwd())
      const items = agents.map((a) => ({ value: a.name, label: a.name, description: a.description }))
      const filtered = items.filter((i) => i.value.startsWith(prefix))
      return filtered.length > 0 ? filtered : null
    },
    handler: async (args, ctx) => {
      const agents = loadAllAgents(ctx.cwd)
      if (agents.length === 0) {
        ctx.ui.notify('No agents found. Add .md files to ~/.pi/agent/agents/', 'error')
        return
      }

      // Parse: /agent <name> [task...]
      const parts = args.trim().split(/\s+/)
      let agentName: string | undefined
      let task: string | undefined

      if (parts[0]) {
        const match = agents.find((a) => a.name === parts[0])
        if (match) {
          agentName = match.name
          task = parts.slice(1).join(' ').trim() || undefined
        } else {
          task = args.trim() || undefined
        }
      }

      // If no agent selected, prompt the user
      if (!agentName) {
        const choice = await ctx.ui.select(
          'Select an agent:',
          agents.map((a) => `${a.name} — ${a.description}`)
        )
        if (!choice) return
        agentName = choice.split(' — ')[0]
      }

      const agent = agents.find((a) => a.name === agentName)
      if (!agent) {
        ctx.ui.notify(`Agent "${agentName}" not found`, 'error')
        return
      }

      // If no task provided, prompt for it
      if (!task) {
        const input = await ctx.ui.input(`Task for ${agent.name}:`)
        if (!input?.trim()) return
        task = input.trim()
      }

      // Send as user message so it flows through the normal agent loop and
      // renders the agent tool result in the chat like any other tool.
      pi.sendUserMessage(`Use the agent tool to run the "${agent.name}" agent with this task: ${task}`)
    },
  })
}
