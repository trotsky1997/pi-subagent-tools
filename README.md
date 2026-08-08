# pi-subagent-tools

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that registers two web-research **subagent** tools. Each forks a dedicated pi session (isolated context) routed through the `macaron-anthropic` provider — where [pi-macaron-harness](https://github.com/trotsky1997/pi-macaron-harness) injects Anthropic-native server-side `web_search` and a client-side `web_fetch` — and returns a structured answer with cited sources.

| Tool | Purpose | Inputs | Returns |
|------|---------|--------|---------|
| **websearch_subagent** | research a question on the live web | `task` + `context?` | 搜索结果 / 结论 / 关键发现 / 出处 |
| **webfetch_subagent** | fetch one URL and extract what you need | `url` + `task` + `context?` | 摘要 / 结论 / 关键信息 / 出处 |

The main session has no direct web access; these are the way to get fresh web facts or read a page.

## Why subagents

The macaron endpoint's `web_search` is a server tool whose results come back as `server_tool_use` / `web_search_tool_result` blocks inside the assistant stream. Forking a session whose model routes through the harness gives us that for free — we consume the rendered text blocks the harness emits and surface the last assistant text as the answer. The subagent runs in its own context window, so the parent session stays clean.

## Install

```
pi install git:github.com/trotsky1997/pi-subagent-tools
```

> Requires [pi-macaron-harness](https://github.com/trotsky1997/pi-macaron-harness) installed and a `macaron-anthropic` provider entry in `~/.pi/agent/models.json`. Restart pi after installing.

## Parameters

### websearch_subagent
- `task` (string, required) — the research prompt. Fold any leads (names, terms, URLs, suspected facts) directly into this text.
- `context` (`"fork"` | `"new"`, optional, default `"new"`) — `fork` inherits the parent session's full conversation; `new` starts fresh.
- `cwd` (string, optional) — working directory for the subagent process.

### webfetch_subagent
- `url` (string, required) — the URL to fetch and read.
- `task` (string, required) — what to extract / summarize / answer from the page.
- `context` (`"fork"` | `"new"`, optional, default `"new"`).
- `cwd` (string, optional).

## context: fork vs new

- `context: "new"` (default) — the subagent starts from a blank slate. Use when the research is self-contained.
- `context: "fork"` — the subagent inherits this session's full conversation so far (via `--fork <sessionFile>`). Use when the research must build on what's already been discussed; the `task` can then be terse, e.g. `"look up the latest release of the repo mentioned above"`. Degrades to `new` if no session file is available (e.g. print mode).

## System-prompt injection

The extension appends a short bullet-style hint to the system prompt via `before_agent_start` with an idempotent guard (`includes` check), so the parent agent knows the tools exist and how to use them. The guard keeps the `systemPrompt` string stable across turns, so prefix-cache stays intact. The guidance travels with the tool — installing the extension brings the hint, uninstalling removes it.

## Env knobs

| Var | Default | Purpose |
|-----|---------|---------|
| `PI_SUBAGENT_MODEL` | `macaron-anthropic/macaron-v1-coding-venti` | model for the subagent process |

## Output contract

Each subagent's final message is structured (enforced via system prompt):

**websearch_subagent**
```
## 搜索结果   — digest of what the searches returned
## 结论       — concise answer to the task
## 关键发现    — 3-6 supporting facts
## 出处        — numbered source list (Title — URL)
```

**webfetch_subagent**
```
## 摘要       — 2-4 line digest of what the page is
## 结论       — concise answer drawn from the page
## 关键信息    — 3-6 specific facts / figures / quotes
## 出处        — primary source (page title — URL)
```

## License

MIT
