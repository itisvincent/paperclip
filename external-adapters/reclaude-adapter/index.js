/**
 * reclaude-paperclip-adapter — external Paperclip agent adapter.
 *
 * Runs the `reclaude` CLI (a drop-in replacement for Claude Code's `claude`)
 * in headless `--print --output-format stream-json` mode and parses its NDJSON
 * event stream, exactly like the built-in claude_local adapter.
 *
 * Self-contained by design: this module is loaded by the Paperclip server via
 * dynamic import() from an arbitrary install location, so it depends ONLY on
 * Node built-ins. It does not import @paperclipai/* (those are private
 * workspace packages that would not resolve from the plugin store).
 *
 * Contract: the package's main entry must export createServerAdapter(), which
 * returns a ServerAdapterModule. See Paperclip's adapter docs.
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const TYPE = "reclaude_local";
const DEFAULT_COMMAND = "reclaude";
const PROVIDER = "anthropic";
const MAX_RAW_CAPTURE = 16_000;

const MODELS = [
  { id: "", label: "(reclaude default)" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
];

const DEFAULT_PROMPT_TEMPLATE = [
  "You are a Paperclip agent. Use the `paperclip` skill to read your assigned work and report progress through the Paperclip API.",
  "",
  "Start actionable work in this heartbeat — do not stop at a plan unless planning was explicitly requested. Make concrete progress, leave a durable next action, and give a clear final disposition. Use child issues to track follow-ups instead of polling. If you are blocked, record the blocker with its owner and the action needed, then stop.",
].join("\n");

const UNKNOWN_SESSION_RE =
  /no conversation found with session id|unknown session|session .* not found/i;

const MAX_TURNS_SUBTYPES = new Set([
  "error_max_turns",
  "max_turns",
  "max_turns_exhausted",
  "turn_limit",
  "turn_limit_exhausted",
]);

// ---------------------------------------------------------------------------
// Safe value extraction helpers (untrusted config + agent output)
// ---------------------------------------------------------------------------

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string" && v.trim().length > 0);
  }
  // Schema-driven config stores extraArgs as a single string — split it.
  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

function parseObject(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function parseJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return null;
}

function truncate(text, max = MAX_RAW_CAPTURE) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function errorText(entry) {
  if (typeof entry === "string") return entry;
  const obj = parseObject(entry);
  return asString(obj.message) || asString(obj.error) || asString(obj.code) || JSON.stringify(entry);
}

// ---------------------------------------------------------------------------
// Minimal {{a.b.c}} template renderer (mirrors renderTemplate semantics)
// ---------------------------------------------------------------------------

function renderTemplate(template, data) {
  if (typeof template !== "string" || template.length === 0) return "";
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, expr) => {
    const parts = String(expr).split(".");
    let cur = data;
    for (const part of parts) {
      if (cur && typeof cur === "object" && part in cur) {
        cur = cur[part];
      } else {
        return "";
      }
    }
    if (cur == null) return "";
    return typeof cur === "object" ? JSON.stringify(cur) : String(cur);
  });
}

// ---------------------------------------------------------------------------
// Paperclip env construction (mirrors buildPaperclipEnv + context injection)
// ---------------------------------------------------------------------------

function resolveHostForUrl(rawHost) {
  const host = (rawHost || "").trim();
  if (!host || host === "0.0.0.0" || host === "::") return "localhost";
  if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
  return host;
}

function buildPaperclipApiUrl() {
  const host = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const port = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  return (
    process.env.PAPERCLIP_RUNTIME_API_URL ??
    process.env.PAPERCLIP_API_URL ??
    `http://${host}:${port}`
  );
}

function setIf(env, key, value) {
  if (typeof value === "string" && value.trim().length > 0) env[key] = value.trim();
}

const SECRET_KEY_RE = /(key|token|secret|password|authorization|cookie)/i;

function redactEnvForLogs(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = SECRET_KEY_RE.test(k) ? "***REDACTED***" : v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// stream-json parsing (mirrors claude_local parse.ts contract)
// ---------------------------------------------------------------------------

function parseReclaudeStreamJson(stdout) {
  let sessionId = null;
  let model = null;
  let resultJson = null;
  const assistantText = [];

  for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    const type = asString(event.type, "");

    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, "") || sessionId;
      model = asString(event.model, "") || model;
    } else if (type === "assistant") {
      if (!sessionId) sessionId = asString(event.session_id, "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const blockRaw of content) {
        const block = parseObject(blockRaw);
        if (asString(block.type, "") === "text") {
          const t = asString(block.text, "");
          if (t) assistantText.push(t);
        }
      }
    } else if (type === "result") {
      resultJson = event;
      if (!sessionId) sessionId = asString(event.session_id, "") || sessionId;
    }
  }

  return { sessionId: sessionId || null, model: model || null, resultJson, assistantText: assistantText.join("") };
}

function isUnknownSessionError(parsed, stdout, stderr) {
  const parts = [];
  const rj = parsed.resultJson;
  if (rj) {
    parts.push(asString(rj.result, ""));
    if (Array.isArray(rj.errors)) parts.push(rj.errors.map(errorText).join(" "));
  }
  parts.push(String(stdout ?? ""));
  parts.push(String(stderr ?? ""));
  return UNKNOWN_SESSION_RE.test(parts.join(" "));
}

// ---------------------------------------------------------------------------
// Process spawning
// ---------------------------------------------------------------------------

function runReclaude({ command, args, cwd, env, prompt, timeoutSec, graceSec, onLog }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch (err) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        spawnError: true,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    let graceTimer = null;

    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(res);
    };

    child.on("error", (err) => {
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        spawnError: true,
        stdout,
        stderr: `${stderr}${err instanceof Error ? err.message : String(err)}`,
      });
    });

    child.stdout.on("data", (chunk) => {
      const s = chunk.toString();
      stdout += s;
      void onLog("stdout", s);
    });
    child.stderr.on("data", (chunk) => {
      const s = chunk.toString();
      stderr += s;
      void onLog("stderr", s);
    });
    child.on("close", (code, signal) => {
      finish({ exitCode: code, signal: signal ?? null, timedOut, stdout, stderr });
    });

    try {
      child.stdin.end(prompt ?? "");
    } catch {
      // ignore — process may have exited before stdin was writable
    }

    if (timeoutSec > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        graceTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore
          }
        }, Math.max(1, graceSec) * 1000);
      }, timeoutSec * 1000);
    }
  });
}

function probeCommand(command, cwd) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, ["--version"], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let out = "";
    let settled = false;
    const done = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      done({ ok: false, error: "version probe timed out" });
    }, 5000);
    child.stdout.on("data", (c) => {
      out += c.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ ok: false, error: err instanceof Error ? err.message : String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, stdout: out });
    });
  });
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

function readConfig(rawConfig) {
  const config = parseObject(rawConfig);
  return {
    command: asString(config.command, DEFAULT_COMMAND).trim() || DEFAULT_COMMAND,
    model: asString(config.model, "").trim(),
    // schema form may store reasoning effort under `effort` or `thinkingEffort`
    effort: (asString(config.effort, "") || asString(config.thinkingEffort, "")).trim(),
    chrome: asBoolean(config.chrome, false),
    maxTurns: asNumber(config.maxTurnsPerRun, 0),
    dangerouslySkipPermissions: asBoolean(config.dangerouslySkipPermissions, true),
    timeoutSec: asNumber(config.timeoutSec, 0),
    graceSec: asNumber(config.graceSec, 15),
    cwd: asString(config.cwd, "").trim(),
    extraArgs: (() => {
      const fromExtra = asStringArray(config.extraArgs);
      return fromExtra.length > 0 ? fromExtra : asStringArray(config.args);
    })(),
    instructionsFilePath: asString(config.instructionsFilePath, "").trim(),
    promptTemplate: asString(config.promptTemplate, DEFAULT_PROMPT_TEMPLATE),
    env: parseObject(config.env),
  };
}

function buildArgs(cfg, resumeSessionId) {
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (cfg.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
  if (cfg.chrome) args.push("--chrome");
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.effort) args.push("--effort", cfg.effort);
  if (cfg.maxTurns > 0) args.push("--max-turns", String(cfg.maxTurns));
  if (cfg.instructionsFilePath && !resumeSessionId) {
    args.push("--append-system-prompt-file", cfg.instructionsFilePath);
  }
  if (cfg.extraArgs.length > 0) args.push(...cfg.extraArgs);
  return args;
}

function buildEnv(agent, runId, context, cfg, authToken) {
  const env = { ...process.env };
  env.PAPERCLIP_AGENT_ID = asString(agent.id, "");
  env.PAPERCLIP_COMPANY_ID = asString(agent.companyId, "");
  env.PAPERCLIP_API_URL = buildPaperclipApiUrl();
  env.PAPERCLIP_RUN_ID = runId;

  setIf(env, "PAPERCLIP_TASK_ID", firstNonEmpty(context.taskId, context.issueId));
  setIf(env, "PAPERCLIP_WAKE_REASON", asString(context.wakeReason, ""));
  setIf(env, "PAPERCLIP_WAKE_COMMENT_ID", firstNonEmpty(context.wakeCommentId, context.commentId));
  setIf(env, "PAPERCLIP_APPROVAL_ID", asString(context.approvalId, ""));
  setIf(env, "PAPERCLIP_APPROVAL_STATUS", asString(context.approvalStatus, ""));
  if (Array.isArray(context.issueIds)) {
    const ids = context.issueIds.filter((v) => typeof v === "string" && v.trim().length > 0);
    if (ids.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = ids.join(",");
  }

  let hasExplicitApiKey = false;
  for (const [k, v] of Object.entries(cfg.env)) {
    if (typeof v === "string") {
      env[k] = v;
      if (k === "PAPERCLIP_API_KEY" && v.trim().length > 0) hasExplicitApiKey = true;
    }
  }
  if (!hasExplicitApiKey && typeof authToken === "string" && authToken.trim().length > 0) {
    env.PAPERCLIP_API_KEY = authToken;
  }
  return env;
}

function toExecutionResult(attempt, parsed, cwd, opts) {
  const { exitCode, signal, timedOut, stdout, stderr, spawnError } = attempt;
  const clearSession = Boolean(opts.clearSession);

  if (timedOut) {
    return {
      exitCode,
      signal,
      timedOut: true,
      errorMessage: `reclaude timed out after ${opts.timeoutSec}s`,
      clearSession,
    };
  }

  const rj = parsed.resultJson;

  if (spawnError || (!rj && (exitCode ?? 1) !== 0)) {
    const firstStderr =
      String(stderr ?? "")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find(Boolean) ?? "";
    const message = spawnError
      ? `Failed to launch "${opts.command}": ${firstStderr || "command not found"}`
      : firstStderr
        ? `reclaude exited with code ${exitCode}: ${firstStderr}`
        : `reclaude exited with code ${exitCode}`;
    return {
      exitCode,
      signal,
      timedOut: false,
      errorMessage: message,
      resultJson: { rawStdout: truncate(stdout), rawStderr: truncate(stderr) },
      clearSession,
    };
  }

  const usageObj = rj ? parseObject(rj.usage) : {};
  const usage = {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
  };
  const costRaw = rj ? rj.total_cost_usd : null;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const subtype = rj ? asString(rj.subtype, "") : "";
  const isError = rj ? rj.is_error === true : false;
  const errors = rj && Array.isArray(rj.errors) ? rj.errors.map(errorText) : [];
  const summary = rj ? asString(rj.result, parsed.assistantText) : parsed.assistantText;
  const sessionId = parsed.sessionId || null;
  const sessionParams = sessionId ? { sessionId, cwd } : null;

  const result = {
    exitCode: exitCode ?? 0,
    signal: signal ?? null,
    timedOut: false,
    usage,
    sessionId,
    sessionParams,
    sessionDisplayId: sessionId,
    provider: PROVIDER,
    model: parsed.model || null,
    costUsd,
    resultJson: rj || null,
    summary: summary || null,
    clearSession,
  };

  if (isError) {
    result.errorMessage =
      errors[0] ||
      (MAX_TURNS_SUBTYPES.has(subtype) ? "reclaude stopped: max turns reached" : null) ||
      summary ||
      "reclaude reported an error";
  }

  return result;
}

async function execute(ctx) {
  const onLog = ctx.onLog ?? (async () => {});
  const agent = parseObject(ctx.agent);
  const runtime = parseObject(ctx.runtime);
  const context = parseObject(ctx.context);
  const runId = asString(ctx.runId, "");
  const cfg = readConfig(ctx.config);

  const cwd = cfg.cwd || process.cwd();
  try {
    await fs.mkdir(cwd, { recursive: true });
  } catch {
    // surfaced later if the spawn fails
  }

  const env = buildEnv(agent, runId, context, cfg, ctx.authToken);

  // Session resume (cwd-aware, mirrors built-in adapters).
  const sessionParams = parseObject(runtime.sessionParams);
  const runtimeSessionId =
    asString(runtime.sessionId, "") || asString(sessionParams.sessionId, "");
  const runtimeSessionCwd = asString(sessionParams.cwd, "");
  const canResume =
    runtimeSessionId.length > 0 &&
    (runtimeSessionCwd.length === 0 ||
      path.resolve(runtimeSessionCwd) === path.resolve(cwd));
  const initialSessionId = canResume ? runtimeSessionId : null;

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };
  const prompt = renderTemplate(cfg.promptTemplate, templateData);

  const runAttempt = async (resumeSessionId) => {
    const args = buildArgs(cfg, resumeSessionId);
    if (ctx.onMeta) {
      await ctx.onMeta({
        adapterType: TYPE,
        command: cfg.command,
        cwd,
        commandArgs: args,
        commandNotes: resumeSessionId
          ? [`Resuming reclaude session ${resumeSessionId}.`]
          : [],
        env: redactEnvForLogs(env),
        prompt,
        promptMetrics: { promptChars: prompt.length },
        context,
      });
    }
    const proc = await runReclaude({
      command: cfg.command,
      args,
      cwd,
      env,
      prompt,
      timeoutSec: cfg.timeoutSec,
      graceSec: cfg.graceSec,
      onLog,
    });
    return { proc, parsed: parseReclaudeStreamJson(proc.stdout) };
  };

  let { proc, parsed } = await runAttempt(initialSessionId);

  if (
    initialSessionId &&
    !proc.timedOut &&
    (proc.exitCode ?? 0) !== 0 &&
    isUnknownSessionError(parsed, proc.stdout, proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] reclaude session "${initialSessionId}" was not found — retrying with a fresh session.\n`,
    );
    ({ proc, parsed } = await runAttempt(null));
    return toExecutionResult(proc, parsed, cwd, {
      clearSession: true,
      command: cfg.command,
      timeoutSec: cfg.timeoutSec,
    });
  }

  return toExecutionResult(proc, parsed, cwd, {
    clearSession: false,
    command: cfg.command,
    timeoutSec: cfg.timeoutSec,
  });
}

async function testEnvironment(ctx) {
  const checks = [];
  const cfg = readConfig(ctx.config);
  const cwd = cfg.cwd || process.cwd();

  try {
    const stat = await fs.stat(cwd);
    if (stat.isDirectory()) {
      checks.push({
        code: "reclaude_cwd_valid",
        level: "info",
        message: `Working directory is valid: ${cwd}`,
      });
    } else {
      checks.push({
        code: "reclaude_cwd_invalid",
        level: "error",
        message: "Configured working directory is not a directory.",
        detail: cwd,
      });
    }
  } catch {
    checks.push({
      code: "reclaude_cwd_invalid",
      level: "error",
      message: "Configured working directory does not exist.",
      detail: cwd,
    });
  }

  const probe = await probeCommand(cfg.command, cwd);
  if (probe.ok) {
    checks.push({
      code: "reclaude_command_resolvable",
      level: "info",
      message: `Command is executable: ${cfg.command}`,
      detail: (probe.stdout || "").trim().split(/\r?\n/)[0] || undefined,
    });
  } else {
    checks.push({
      code: "reclaude_command_unresolvable",
      level: "error",
      message: `Command is not executable: ${cfg.command}`,
      detail: probe.error || undefined,
      hint: `Ensure "${cfg.command}" is installed and on the server's PATH.`,
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    checks.push({
      code: "reclaude_anthropic_api_key",
      level: "warn",
      message:
        "ANTHROPIC_API_KEY is set. reclaude will use API-key auth instead of subscription credentials.",
      hint: "Unset ANTHROPIC_API_KEY for subscription-based login behavior.",
    });
  } else {
    checks.push({
      code: "reclaude_subscription_mode_possible",
      level: "info",
      message:
        "ANTHROPIC_API_KEY is not set; subscription-based auth can be used if reclaude is logged in.",
    });
  }

  const status = checks.some((c) => c.level === "error")
    ? "fail"
    : checks.some((c) => c.level === "warn")
      ? "warn"
      : "pass";

  return {
    adapterType: TYPE,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

const sessionCodec = {
  deserialize(raw) {
    const obj = parseObject(raw);
    const sessionId = asString(obj.sessionId, "") || asString(obj.session_id, "");
    if (!sessionId) return null;
    const params = { sessionId };
    const cwd = asString(obj.cwd, "");
    if (cwd) params.cwd = cwd;
    return params;
  },
  serialize(params) {
    const obj = parseObject(params);
    const sessionId = asString(obj.sessionId, "");
    if (!sessionId) return null;
    const out = { sessionId };
    const cwd = asString(obj.cwd, "");
    if (cwd) out.cwd = cwd;
    return out;
  },
  getDisplayId(params) {
    const obj = parseObject(params);
    return asString(obj.sessionId, "") || null;
  },
};

function getConfigSchema() {
  return {
    fields: [
      {
        key: "command",
        label: "CLI binary",
        type: "text",
        default: DEFAULT_COMMAND,
        hint: "Executable Paperclip spawns (default: reclaude). Must be on the server's PATH.",
      },
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        hint: "Absolute path the agent runs in. Defaults to the server's working directory.",
      },
      {
        key: "model",
        label: "Model",
        type: "select",
        default: "",
        options: MODELS.map((m) => ({ label: m.label, value: m.id })),
        hint: "Passed via --model. Leave as default to let reclaude choose.",
      },
      {
        key: "effort",
        label: "Reasoning effort",
        type: "select",
        default: "",
        options: [
          { label: "(default)", value: "" },
          { label: "Low", value: "low" },
          { label: "Medium", value: "medium" },
          { label: "High", value: "high" },
        ],
        hint: "Passed via --effort.",
      },
      {
        key: "instructionsFilePath",
        label: "Agent instructions file",
        type: "text",
        hint: "Absolute path to a markdown file injected via --append-system-prompt-file (fresh sessions only).",
      },
      {
        key: "dangerouslySkipPermissions",
        label: "Skip permissions",
        type: "toggle",
        default: true,
        hint: "Pass --dangerously-skip-permissions. Required for headless --print mode where prompts cannot be answered.",
      },
      {
        key: "chrome",
        label: "Enable Chrome",
        type: "toggle",
        default: false,
        hint: "Pass --chrome.",
      },
      {
        key: "maxTurnsPerRun",
        label: "Max turns per run",
        type: "number",
        default: 0,
        hint: "Pass --max-turns. 0 = no limit.",
      },
      {
        key: "extraArgs",
        label: "Extra args",
        type: "text",
        hint: "Additional CLI args, separated by spaces or commas.",
      },
      {
        key: "promptTemplate",
        label: "Prompt template",
        type: "textarea",
        hint: "Run prompt. Supports {{agent.name}}, {{runId}}, {{context.*}} placeholders. Leave blank for the default.",
      },
    ],
  };
}

function getRuntimeCommandSpec(rawConfig) {
  const cfg = readConfig(rawConfig);
  return {
    command: cfg.command,
    detectCommand: cfg.command,
    installCommand: null,
  };
}

const agentConfigurationDoc = `# reclaude_local agent configuration

Adapter: reclaude_local

Runs the \`reclaude\` CLI — a drop-in replacement for Claude Code (\`claude\`) — in
headless \`--print --output-format stream-json\` mode.

Use when:
- You want this agent to run the reclaude binary instead of the official claude CLI.
- reclaude is installed on the server/host and on PATH.

Don't use when:
- reclaude is not installed (use the built-in claude_local adapter instead).
- The replacement binary does not emit Claude Code's stream-json event format.

Core fields:
- command (string, optional): executable to spawn. Default "reclaude".
- cwd (string, optional): absolute working directory (created if missing).
- model (string, optional): model id passed via --model.
- effort (string, optional): reasoning effort passed via --effort (low|medium|high).
- instructionsFilePath (string, optional): absolute markdown file injected via --append-system-prompt-file (fresh sessions only).
- dangerouslySkipPermissions (boolean, optional, default true): pass --dangerously-skip-permissions; required for headless --print mode.
- chrome (boolean, optional): pass --chrome.
- maxTurnsPerRun (number, optional): pass --max-turns; 0 = unlimited.
- extraArgs (string|string[], optional): additional CLI args.
- promptTemplate (string, optional): run prompt template with {{var}} placeholders.
- env (object, optional): KEY=VALUE environment variables (secrets injected as env, never into the prompt).

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = none).
- graceSec (number, optional): SIGTERM grace period before SIGKILL (default 15).

Auth: honors ANTHROPIC_API_KEY (API-key mode) and CLAUDE_CONFIG_DIR, same as claude.
`;

/**
 * Required external-adapter entry point. Returns a ServerAdapterModule.
 */
export function createServerAdapter() {
  return {
    type: TYPE,
    execute,
    testEnvironment,
    sessionCodec,
    getConfigSchema,
    getRuntimeCommandSpec,
    models: MODELS.filter((m) => m.id.length > 0),
    supportsLocalAgentJwt: true,
    supportsInstructionsBundle: false,
    agentConfigurationDoc,
  };
}

export default createServerAdapter;
