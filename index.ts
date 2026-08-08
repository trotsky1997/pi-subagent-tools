/**
 * websearch_subagent + webfetch_subagent — two tools sharing one extension.
 *
 * Both fork a dedicated pi session (isolated context) routed through the
 * macaron-anthropic provider, where pi-macaron-harness injects:
 *   - Anthropic-native server-side web_search (websearch_subagent uses this)
 *   - a client-side web_fetch tool: HTTP + Readability + Turndown (webfetch_subagent)
 *
 * They share the spawn + JSON-event parse + progress + render machinery below;
 * they differ only in system prompt, the composed user task, and which tool
 * calls to surface in the collapsed trail (web_search vs web_fetch).
 *
 * Requires: pi-macaron-harness extension installed + a macaron-anthropic
 * provider entry in ~/.pi/agent/models.json.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-coding-agent";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getMarkdownTheme, withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

const DEFAULT_MODEL = process.env.PI_SUBAGENT_MODEL || "macaron-anthropic/macaron-v1-coding-venti";

// ---------------------------------------------------------------------------
// shared types + helpers
// ---------------------------------------------------------------------------

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SubResult {
	/** The composed user prompt actually handed to the subagent. */
	task: string;
	/** fork = inherited parent session messages; new = fresh empty session. */
	contextMode: "fork" | "new";
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model: string;
	stopReason?: string;
	errorMessage?: string;
}

interface SubagentDetails {
	result: SubResult;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

/** Render a single tool call; `trailTool` is highlighted, others shown compactly. */
function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
	trailTool: string,
): string {
	if (toolName === trailTool) {
		const q = (args.query as string) || (args.url as string) || "";
		return themeFg("muted", `→ ${trailTool} `) + themeFg("accent", q);
	}
	const argsStr = JSON.stringify(args);
	const preview = argsStr.length > 60 ? `${argsStr.slice(0, 60)}...` : argsStr;
	return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

async function writePromptToTempFile(prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const filePath = path.join(tmpDir, "prompt.md");
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

// Resolve how to invoke pi in the subprocess (reuse current entry script if
// available, else fall back to the `pi` binary on PATH). Mirrors the subagent
// example so subprocesses load the same installed extensions (incl. the harness).
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentDetails>) => void;

/**
 * Fork a pi subagent, hand it `task` as the user turn (with `systemPrompt`
 * appended to the system prompt), stream progress, return the captured result.
 */
async function runSubagent(
	task: string,
	systemPrompt: string,
	contextMode: "fork" | "new",
	sessionFile: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SubResult> {
	const model = DEFAULT_MODEL;
	const result: SubResult = {
		task,
		contextMode,
		exitCode: -1,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model,
	};

	// fork = subagent inherits the parent session's context (messages); new = empty.
	// --fork <file> conflicts with --no-session, so we pick one per mode.
	const args: string[] = ["--mode", "json", "-p", "--model", model];
	if (contextMode === "fork" && sessionFile) {
		args.push("--fork", sessionFile);
	} else {
		args.push("--no-session");
		if (contextMode === "fork") {
			// fork requested but no session file available (e.g. print mode) — degrade to new.
			result.contextMode = "new";
		}
	}

	let tmpDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(result.messages) || "(working...)" }],
				details: { result },
			});
		}
	};

	try {
		const tmp = await writePromptToTempFile(systemPrompt);
		tmpDir = tmp.dir;
		tmpPromptPath = tmp.filePath;
		args.push("--append-system-prompt", tmpPromptPath);
		// The task IS the prompt. In fork mode the parent session's messages are
		// already in the subagent's context; the task is the next user turn on top.
		args.push(`Task: ${task}`);

		let wasAborted = false;
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				stdio: ["ignore", "pipe", "pipe"],
				shell: false,
			});

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						result.usage.turns++;
						const u = msg.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							const c = u.cost;
							if (c) result.usage.cost += c.total ?? 0;
							result.usage.contextTokens = u.totalTokens || result.usage.contextTokens;
						}
						if (msg.stopReason) result.stopReason = msg.stopReason;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					result.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		result.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return result;
	} finally {
		if (tmpPromptPath) {
			try { fs.unlinkSync(tmpPromptPath); } catch { /* ignore */ }
		}
		if (tmpDir) {
			try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}
}

/**
 * Shared result renderer. `toolLabel` is the bold title shown in the UI;
 * `trailTool` is the tool-call name to surface in the collapsed trail.
 */
function renderSubagentResult(
	result: AgentToolResult<SubagentDetails>,
	opts: { expanded: boolean },
	theme: any,
	toolLabel: string,
	trailTool: string,
) {
	const details = result.details as SubagentDetails | undefined;
	if (!details) {
		const t = result.content[0];
		return new Text(t?.type === "text" ? t.text : "(no output)", 0, 0);
	}

	const r = details.result;
	const isError = r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";
	const icon = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
	const displayItems = getDisplayItems(r.messages);
	const finalOutput = getFinalOutput(r.messages);
	const mdTheme = getMarkdownTheme();
	const fg = theme.fg.bind(theme);

	if (opts.expanded) {
		const container = new Container();
		let header = `${icon} ${theme.fg("toolTitle", theme.bold(toolLabel))}`;
		if (isError && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (isError && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
		container.addChild(new Text(header, 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
		container.addChild(new Text(theme.fg("muted", `context: ${r.contextMode}`), 0, 0));
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Trail ───"), 0, 0));
		if (displayItems.length === 0) {
			container.addChild(new Text(theme.fg("muted", "(no tool calls)"), 0, 0));
		} else {
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(new Text(theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, fg, trailTool), 0, 0));
				} else {
					// intermediate text (search/fetch result blocks rendered by the harness)
					const preview = item.text.length > 200 ? `${item.text.slice(0, 200)}...` : item.text;
					container.addChild(new Text(theme.fg("dim", preview), 0, 0));
				}
			}
		}
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "─── Answer ───"), 0, 0));
		if (finalOutput) {
			container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
		} else {
			container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		return container;
	}

	// Collapsed: icon + label + task + trail tool calls + final answer (truncated)
	let text = `${icon} ${theme.fg("toolTitle", theme.bold(toolLabel))}`;
	text += `\n${theme.fg("dim", r.task)}`;
	text += `\n${theme.fg("muted", `context: ${r.contextMode}`)}`;

	const trail = displayItems.filter((i) => i.type === "toolCall" && i.name === trailTool);
	if (trail.length > 0) {
		text += `\n${theme.fg("muted", `${trailTool} (${trail.length}):`)}`;
		for (const s of trail.slice(-3)) {
			text += `\n  ${theme.fg("muted", "→ ") + formatToolCall(s.name, s.args, fg, trailTool)}`;
		}
	}

	if (finalOutput) {
		const preview = finalOutput.length > 400 ? `${finalOutput.slice(0, 400)}...` : finalOutput;
		text += `\n\n${theme.fg("toolOutput", preview)}`;
		text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	} else {
		text += `\n${theme.fg("muted", "(no output)")}`;
	}
	const usageStr = formatUsageStats(r.usage, r.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return new Text(text, 0, 0);
}

/** Shared execute body: run the subagent, return content + details (or error). */
async function executeSubagent(
	task: string,
	systemPrompt: string,
	contextMode: "fork" | "new",
	sessionFile: string | undefined,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	failLabel: string,
): Promise<AgentToolResult<SubagentDetails>> {
	const result = await runSubagent(task, systemPrompt, contextMode, sessionFile, cwd, signal, onUpdate);
	const isError = result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
	if (isError) {
		const errMsg = result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
		return {
			content: [{ type: "text", text: `${failLabel} failed (${result.stopReason || "error"}): ${errMsg}` }],
			details: { result },
			isError: true,
		} as AgentToolResult<SubagentDetails>;
	}
	const output = getFinalOutput(result.messages) || "(no output)";
	return {
		content: [{ type: "text", text: output }],
		details: { result },
	} as AgentToolResult<SubagentDetails>;
}

// ---------------------------------------------------------------------------
// system prompts
// ---------------------------------------------------------------------------

const SEARCH_SYSTEM_PROMPT = `You are a web research subagent. You have a native server-side web_search tool.

Your job: research the task in the user prompt using web_search, then return a single,
self-contained answer. The task may already contain leads (names, terms, URLs, suspected facts)
you should fold into your queries to sharpen them — they are leads, not answers; verify
everything against fresh results. If you were forked from a parent session, you may also see
prior conversation context — use it as background, but still cite web sources for any claim
that extends beyond it.

Process:
1. Issue focused web_search queries. Refine if initial results are weak.
2. You may issue multiple searches (up to 6) to triangulate.
3. Synthesize findings into one final answer — do NOT hand back raw search dumps.

Your FINAL message must be structured EXACTLY as:

## 搜索结果
A compact digest of what the searches returned: the most relevant results and the key facts each
yielded (1-2 lines each). This is the raw evidence layer, not the answer.

## 结论
A concise, direct answer to the task. Lead with the conclusion. If the evidence is mixed,
uncertain, or the task can't be resolved from available sources, say so plainly.

## 关键发现
- point 1
- point 2
- (3-6 supporting facts that justify the conclusion)

## 出处
1. <Title> — https://...
2. <Title> — https://...
(list every source you actually used; URLs must come from the search results or the task's leads)

Rules:
- Every claim in 结论/关键发现 must trace to a source in 出处 or to the forked parent context.
- If you cannot find a confident answer, say "未找到可靠来源" and list what you did find under 搜索结果.
- Do not apologize, do not narrate your process, do not emit anything after 出处.`;

const FETCH_SYSTEM_PROMPT = `You are a web fetch subagent. You have a web_fetch tool that retrieves a URL and
returns its page content as clean Markdown (the harness strips noise and converts HTML).

Your job: fetch the URL given in the task, then extract / summarize what the task asks for
from that page. Return a single, self-contained answer.

Process:
1. Call web_fetch on the URL.
2. Read the returned content and pull out what the task needs. If the fetch fails or the
   page is empty/unreadable, report that plainly.
3. If the single page is insufficient, you may issue follow-up web_search queries to fill
   gaps — but lead with what the fetched URL actually said.

Your FINAL message must be structured EXACTLY as:

## 摘要
A 2-4 line digest of what the fetched page is about (its nature + main content), so the
reader knows what the source is before reading the answer.

## 结论
A concise, direct answer to the task, drawn from the fetched page. Lead with the conclusion.
If the page doesn't contain what the task asked for, say so plainly.

## 关键信息
- point 1
- point 2
- (3-6 specific facts / figures / quotes from the page that justify the conclusion)

## 出处
1. <Page title> — <the fetched URL>
(the primary source is the fetched URL; add any supplementary web_search sources you used)

Rules:
- Every claim in 结论/关键信息 must trace to the fetched page or a source in 出处.
- Quote figures and proper nouns verbatim where exactness matters.
- If you were forked from a parent session, you may see prior conversation context — use it
  as background, but the answer must rest on the fetched URL.
- Do not apologize, do not narrate your process, do not emit anything after 出处.`;

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

const SearchParams = Type.Object({
	task: Type.String({ description: "The research task / question to investigate on the web — the subagent's full prompt. Fold any leads (names, terms, URLs) directly into this text." }),
	context: Type.Optional(StringEnum(["fork", "new"] as const, { description: "fork = inherit the parent session's full context (messages); new = fresh empty session. Default: new.", default: "new" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process. Defaults to the current cwd." })),
});

const FetchParams = Type.Object({
	url: Type.String({ description: "The URL to fetch and read. The subagent's web_fetch tool retrieves it." }),
	task: Type.String({ description: "What to extract / summarize / answer from the fetched page — the subagent's full prompt." }),
	context: Type.Optional(StringEnum(["fork", "new"] as const, { description: "fork = inherit the parent session's full context (messages); new = fresh empty session. Default: new.", default: "new" })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the subagent process. Defaults to the current cwd." })),
});

function resolveContextMode(params: any): "fork" | "new" {
	return params.context === "fork" ? "fork" : "new";
}

// ---------------------------------------------------------------------------
// system-prompt injection: tell the parent agent these tools exist and how to use them.
// before_agent_start + idempotent guard (matches pi-cli-tools' pattern): only appends if
// the marker string isn't already in the system prompt, so every turn yields a stable
// systemPrompt string and prefix-cache stays intact. Guidance travels with the tool —
// installing the extension brings the hint, uninstalling removes it.
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_INJECTION = `

## Web research tools

The main session has no direct web access. Use these two subagent tools for anything needing fresh web facts or page content:

- **websearch_subagent**(task, context?) — research a question on the live web. Put any leads (names, terms, URLs) directly in \`task\`. Returns 搜索结果 / 结论 / 关键发现 / 出处.
- **webfetch_subagent**(url, task, context?) — fetch one URL and extract what \`task\` asks for. Returns 摘要 / 结论 / 关键信息 / 出处.

Usage:
- \`task\` must be self-contained — the subagent sees nothing else unless you set \`context\`.
- \`context: "fork"\` lets the subagent inherit this session's conversation (use when research builds on what's already discussed; then \`task\` can be terse). Default \`new\` = blank slate.
- Reach for these over guessing for anything time-sensitive (recent releases, live status, current prices, news).
- The returned 出处 (source URLs) are the source of truth — cite them when passing findings to the user.
`;

const INJECTION_MARKER = "Web research tools";

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		if (event.systemPrompt.includes(INJECTION_MARKER)) return;
		return { systemPrompt: event.systemPrompt + SYSTEM_PROMPT_INJECTION };
	});

	// --- websearch_subagent ---
	pi.registerTool({
		name: "websearch_subagent",
		label: "Web Search Subagent",
		description: [
			"Fork a dedicated web-search session (isolated context) that uses the macaron-anthropic provider's",
			"native server-side web_search, then returns 搜索结果 / 结论 / 关键发现 / 出处 (sources).",
			"Inputs: task (the full prompt, leads folded in). context=fork inherits the parent session's",
			"messages; context=new (default) starts fresh. Use when the main session needs fresh web facts",
			"with cited sources, optionally building on what's already been discussed.",
		].join(" "),

		parameters: SearchParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd || ctx.cwd;
			const contextMode = resolveContextMode(params);
			const sessionFile = contextMode === "fork" ? ctx.sessionManager.getSessionFile() : undefined;
			return executeSubagent(params.task, SEARCH_SYSTEM_PROMPT, contextMode, sessionFile, cwd, signal, onUpdate as OnUpdateCallback | undefined, "Web search");
		},

		renderCall(args, theme) {
			const task = args.task ? (args.task.length > 70 ? `${args.task.slice(0, 70)}...` : args.task) : "...";
			const mode = args.context === "fork" ? " [fork]" : "";
			const text =
				theme.fg("toolTitle", theme.bold("websearch_subagent")) +
				theme.fg("muted", mode) +
				"\n  " + theme.fg("dim", task);
			return new Text(text, 0, 0);
		},

		renderResult(result, opts, theme) {
			return renderSubagentResult(result, opts, theme, "websearch_subagent", "web_search");
		},
	});

	// --- webfetch_subagent ---
	pi.registerTool({
		name: "webfetch_subagent",
		label: "Web Fetch Subagent",
		description: [
			"Fork a dedicated session that fetches a URL (macaron-anthropic client-side web_fetch: HTTP +",
			"Readability + Turndown) and extracts what the task asks for, then returns 摘要 / 结论 /",
			"关键信息 / 出处. Inputs: url (required) + task (what to extract). context=fork inherits the",
			"parent session's messages; context=new (default) starts fresh. Use to read a specific page",
			"and pull structured facts out of it, optionally building on prior conversation.",
		].join(" "),

		parameters: FetchParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const cwd = params.cwd || ctx.cwd;
			const contextMode = resolveContextMode(params);
			const sessionFile = contextMode === "fork" ? ctx.sessionManager.getSessionFile() : undefined;
			// Compose the user turn: the URL to fetch first, then the task describing what to extract.
			const task = `URL: ${params.url}\n\n${params.task}`;
			return executeSubagent(task, FETCH_SYSTEM_PROMPT, contextMode, sessionFile, cwd, signal, onUpdate as OnUpdateCallback | undefined, "Web fetch");
		},

		renderCall(args, theme) {
			const url = args.url ? (args.url.length > 60 ? `${args.url.slice(0, 60)}...` : args.url) : "...";
			const task = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "";
			const mode = args.context === "fork" ? " [fork]" : "";
			let text =
				theme.fg("toolTitle", theme.bold("webfetch_subagent")) +
				theme.fg("muted", mode) +
				"\n  " + theme.fg("accent", url);
			if (task) text += "\n  " + theme.fg("dim", task);
			return new Text(text, 0, 0);
		},

		renderResult(result, opts, theme) {
			return renderSubagentResult(result, opts, theme, "webfetch_subagent", "web_fetch");
		},
	});
}
