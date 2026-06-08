/**
 * reclaude-paperclip-adapter UI parser.
 *
 * Served as raw source to the Paperclip board UI and evaluated inside a
 * sandboxed Web Worker via `new Function(exports, module, ...)`. It must:
 *   - be CommonJS (assign to `module.exports` / `exports`), NOT ESM,
 *   - be pure JavaScript with no imports and no Node/DOM/network APIs,
 *   - export `parseStdoutLine(line, ts) -> TranscriptEntry[]`.
 *
 * It converts reclaude's NDJSON stream-json events into TranscriptEntry[]
 * for the run detail viewer — identical event shapes to Claude Code.
 */

"use strict";

function asString(value, fallback) {
  return typeof value === "string" ? value : fallback === undefined ? "" : fallback;
}

function asNumber(value, fallback) {
  if (typeof value === "number" && isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    var n = Number(value);
    if (isFinite(n)) return n;
  }
  return fallback === undefined ? 0 : fallback;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(function (part) {
        if (typeof part === "string") return part;
        var obj = asObject(part);
        return asString(obj.text, "");
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch (e) {
    return String(content);
  }
}

function errorText(entry) {
  if (typeof entry === "string") return entry;
  var obj = asObject(entry);
  return asString(obj.message) || asString(obj.error) || asString(obj.code) || "";
}

function parseStdoutLine(line, ts) {
  var trimmed = typeof line === "string" ? line.trim() : "";
  if (!trimmed) return [];

  var event;
  try {
    event = JSON.parse(trimmed);
  } catch (e) {
    return [{ kind: "stdout", ts: ts, text: line }];
  }
  if (!event || typeof event !== "object") {
    return [{ kind: "stdout", ts: ts, text: line }];
  }

  var type = asString(event.type, "");
  var entries = [];

  if (type === "system" && asString(event.subtype, "") === "init") {
    return [
      {
        kind: "init",
        ts: ts,
        model: asString(event.model, ""),
        sessionId: asString(event.session_id, ""),
      },
    ];
  }

  if (type === "assistant") {
    var aMsg = asObject(event.message);
    var aContent = Array.isArray(aMsg.content) ? aMsg.content : [];
    for (var i = 0; i < aContent.length; i++) {
      var block = asObject(aContent[i]);
      var bType = asString(block.type, "");
      if (bType === "text") {
        var text = asString(block.text, "");
        if (text) entries.push({ kind: "assistant", ts: ts, text: text });
      } else if (bType === "thinking") {
        var thinking = asString(block.thinking, "");
        if (thinking) entries.push({ kind: "thinking", ts: ts, text: thinking });
      } else if (bType === "tool_use") {
        entries.push({
          kind: "tool_call",
          ts: ts,
          name: asString(block.name, "tool"),
          input: block.input == null ? {} : block.input,
          toolUseId:
            typeof block.id === "string"
              ? block.id
              : typeof block.tool_use_id === "string"
                ? block.tool_use_id
                : undefined,
        });
      }
    }
    return entries;
  }

  if (type === "user") {
    var uMsg = asObject(event.message);
    var uContent = Array.isArray(uMsg.content) ? uMsg.content : [];
    for (var j = 0; j < uContent.length; j++) {
      var ublock = asObject(uContent[j]);
      var uType = asString(ublock.type, "");
      if (uType === "tool_result") {
        entries.push({
          kind: "tool_result",
          ts: ts,
          toolUseId: asString(ublock.tool_use_id, ""),
          content: toolResultText(ublock.content),
          isError: ublock.is_error === true,
        });
      } else if (uType === "text") {
        var utext = asString(ublock.text, "");
        if (utext) entries.push({ kind: "user", ts: ts, text: utext });
      }
    }
    return entries;
  }

  if (type === "result") {
    var usage = asObject(event.usage);
    var errors = Array.isArray(event.errors) ? event.errors.map(errorText).filter(Boolean) : [];
    return [
      {
        kind: "result",
        ts: ts,
        text: asString(event.result, ""),
        inputTokens: asNumber(usage.input_tokens, 0),
        outputTokens: asNumber(usage.output_tokens, 0),
        cachedTokens: asNumber(usage.cache_read_input_tokens, 0),
        costUsd: asNumber(event.total_cost_usd, 0),
        subtype: asString(event.subtype, ""),
        isError: event.is_error === true,
        errors: errors,
      },
    ];
  }

  // Unknown event types carry no transcript meaning.
  return [];
}

module.exports = { parseStdoutLine: parseStdoutLine };
