/**
 * Post Tool Hook Extension
 *
 * Runs a configurable shell command after tool execution.
 * Configure in settings.json:
 *
 *   {
 *     "postToolHook": {
 *       "command": "my-validator '{{path}}'",
 *       "tools": ["edit", "write"],
 *       "timeout": 10000,
 *       "blockOnError": false,
 *       "skipOnToolError": false
 *     }
 *   }
 *
 * Placeholders: {{tool}}, {{path}}, {{callId}}, {{status}}
 * - {{path}}: resolved from input.path (read/write/edit), input.command (bash), or empty
 * - {{status}}: "success" or "error"
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface HookConfig {
	command: string;
	tools?: string[];
	timeout?: number;
	blockOnError?: boolean;
	skipOnToolError?: boolean;
}

function loadConfig(cwd: string): HookConfig | null {
	const files = [
		join(homedir(), ".pi", "agent", "settings.json"),
		join(cwd, ".pi", "settings.json"),
	];

	let merged: Record<string, unknown> = {};
	for (const f of files) {
		if (existsSync(f)) {
			try {
				const parsed = JSON.parse(readFileSync(f, "utf8"));
				if (parsed.postToolHook) merged = { ...merged, ...parsed.postToolHook };
			} catch {}
		}
	}

	if (!merged.command || typeof merged.command !== "string") return null;
	return {
		command: merged.command,
		tools: Array.isArray(merged.tools) ? merged.tools : undefined,
		timeout: typeof merged.timeout === "number" ? merged.timeout : 10000,
		blockOnError: merged.blockOnError === true,
		skipOnToolError: merged.skipOnToolError === true,
	};
}

function extractPath(toolName: string, input: Record<string, unknown>): string {
	if (typeof input.path === "string") return input.path;
	if (toolName === "bash" && typeof input.command === "string") return input.command;
	return "";
}

const MAX_SUMMARY_LINES = 5;
const MAX_SUMMARY_LENGTH = 300;

function getSummary(stdout: string, stderr: string): string {
	const text = (stdout || stderr).trim();
	if (!text) return "no violations";
	const lines = text.split("\n");
	const truncated = lines.length > MAX_SUMMARY_LINES
		? lines.slice(0, MAX_SUMMARY_LINES).join("\n") + `\n... (${lines.length - MAX_SUMMARY_LINES} more lines)`
		: text;
	return truncated.length > MAX_SUMMARY_LENGTH
		? truncated.slice(0, MAX_SUMMARY_LENGTH) + "..."
		: truncated;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		const config = loadConfig(ctx.cwd);
		if (!config) return;
		if (config.tools?.length && !config.tools.includes(event.toolName)) return;

		if (config.skipOnToolError && event.isError) return;

		const status = event.isError ? "error" : "success";
		const path = extractPath(event.toolName, event.input as Record<string, unknown>);

		const cmd = config.command
			.replace(/\{\{tool\}\}/g, event.toolName)
			.replace(/\{\{path\}\}/g, path.replace(/'/g, "'\\''"))
			.replace(/\{\{callId\}\}/g, event.toolCallId)
			.replace(/\{\{status\}\}/g, status);

		if (ctx.hasUI) ctx.ui.setStatus("post-tool-hook", "⏳ Running guardrail check...");

		const run = async () => {
			try {
				const result = await pi.exec("sh", ["-c", cmd], {
					signal: ctx.signal,
					timeout: config.timeout,
				});
				return result;
			} catch (err) {
				return null;
			} finally {
				if (ctx.hasUI) ctx.ui.setStatus("post-tool-hook", undefined);
			}
		};

		if (config.blockOnError) {
			const result = await run();
			if (!result) return;

			const summary = getSummary(result.stdout, result.stderr);
			const hookOutput = [result.stdout, result.stderr].filter(s => s.trim()).join("\n").trim();

			if (result.code !== 0) {
				if (ctx.hasUI) ctx.ui.notify(`🚫 Guardrail: ${summary}`, "error");
				return {
					content: [
						...event.content,
						{ type: "text" as const, text: `\n[post-tool-hook] ${hookOutput}` },
					],
				};
			} else {
				if (ctx.hasUI) ctx.ui.notify(`✓ Guardrail: ${summary}`, "info");
				if (hookOutput) {
					return {
						content: [
							...event.content,
							{ type: "text" as const, text: `\n[post-tool-hook] ${hookOutput}` },
						],
					};
				}
			}
		} else {
			const p = run();
			p.then((result) => {
				if (!result || !ctx.hasUI) return;
				const summary = getSummary(result.stdout, result.stderr);
				if (result.code !== 0) {
					ctx.ui.notify(`🚫 Guardrail: ${summary}`, "error");
				} else {
					ctx.ui.notify(`✓ Guardrail: ${summary}`, "info");
				}
			});
		}
	});
};
