/**
 * pi-simple-ast-grep Extension for pi
 *
 * Registers custom tools for structural code search and rule-based scanning.
 * Hooks tool_call to auto-validate edits against project sgconfig.yml rules.
 *
 * Prerequisites: `sg` (or `ast-grep`) must be installed.
 *   npm install -g @ast-grep/cli
 *
 * Usage:
 *   pi -e ./extensions/pi-simple-ast-grep.ts  # quick test
 *   # or place in ~/.pi/agent/extensions/pi-simple-ast-grep/
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { access, constants, mkdir, writeFile } from "node:fs/promises";
import { relative, resolve, dirname, join, isAbsolute } from "node:path";
import { homedir, platform } from "node:os";

// ── Helpers ──────────────────────────────────────────────────────────────────

type SgInvocation = {
  command: string;
  prefixArgs: string[];
  checkPath?: string;
};

/** Return true only when an ast-grep invocation actually runs successfully. */
async function canRunSg(invocation: SgInvocation, signal?: AbortSignal): Promise<boolean> {
  try {
    const { code } = await execAsync(
      invocation.command,
      [...invocation.prefixArgs, "--version"],
      { timeout: 5000, signal },
    );
    return code === 0;
  } catch {
    return false;
  }
}

/** Resolve the `sg` binary. Handles broken npm shims on Windows by finding real package binaries. */
async function findSgBinary(signal?: AbortSignal): Promise<SgInvocation | null> {
  const isWin = platform() === "win32";

  // 1. Try PATH lookup. Nonzero exits are rejected here so broken npm shims do not pass discovery.
  for (const bin of ["sg", "ast-grep"]) {
    const invocation = { command: bin, prefixArgs: [] };
    if (await canRunSg(invocation, signal)) return invocation;
  }

  // 2. Windows fallback: npm global shims plus real package bin locations.
  if (isWin) {
    const npmRoot = process.env.APPDATA
      ? join(process.env.APPDATA, "npm")
      : join(homedir(), "AppData", "Roaming", "npm");
    const packageRoot = join(npmRoot, "node_modules", "@ast-grep", "cli");

    const candidates: SgInvocation[] = [];
    const addWindowsCandidate = (filePath: string) => {
      if (/\.ps1$/i.test(filePath)) {
        candidates.push({
          command: "powershell.exe",
          prefixArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filePath],
          checkPath: filePath,
        });
      } else {
        candidates.push({ command: filePath, prefixArgs: [] });
      }
    };

    for (const bin of ["sg", "ast-grep"]) {
      for (const ext of [".exe", ".cmd", ".ps1", ""]) {
        addWindowsCandidate(join(npmRoot, `${bin}${ext}`));
      }
      for (const ext of [".exe", ".cmd", ".ps1", ""]) {
        addWindowsCandidate(join(packageRoot, `${bin}${ext}`));
        addWindowsCandidate(join(packageRoot, "bin", `${bin}${ext}`));
      }
    }

    for (const candidate of candidates) {
      try {
        await access(candidate.checkPath ?? candidate.command, constants.R_OK);
      } catch {
        continue;
      }
      if (await canRunSg(candidate, signal)) return candidate;
    }
  }

  // Do not fall back to npx. @ast-grep/cli exposes extensionless native binaries,
  // and npm/npx can try to execute them through node on Windows.
  return null;
}

// Module-level state shared between discovery and tool execution.
let sgResolvedInvocation: SgInvocation | null = null;

/** Build arg array for sg invocation, handling prefix wrappers. */
function buildSgArgs(args: string[]): [string, string[]] {
  if (!sgResolvedInvocation) throw new Error("sg not resolved");
  return [sgResolvedInvocation.command, [...sgResolvedInvocation.prefixArgs, ...args]];
}

/** Spawn a process and capture stdout/stderr. */
function execAsync(
  command: string,
  args: string[],
  opts: { cwd?: string; timeout?: number; maxOutput?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const { cwd, timeout, maxOutput = 5_000_000, signal } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Command aborted"));
      return;
    }

    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: platform() === "win32" && /\.(cmd|bat)$/i.test(command),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (abortHandler) signal?.removeEventListener("abort", abortHandler);
    };

    const settleResolve = (value: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < maxOutput) stdout += d.toString("utf-8");
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < maxOutput) stderr += d.toString("utf-8");
    });

    abortHandler = () => {
      child.kill();
      settleReject(new Error("Command aborted"));
    };
    signal?.addEventListener("abort", abortHandler, { once: true });

    timer = timeout
      ? setTimeout(() => {
          child.kill();
          settleReject(new Error(`Command timed out after ${timeout}ms`));
        }, timeout)
      : null;

    child.on("error", settleReject);
    child.on("close", (code) => {
      settleResolve({ stdout: stdout.slice(0, maxOutput), stderr, code: code ?? 1 });
    });
  });
}

/** Truncate text to a maximum byte length, adding a suffix. */
function truncateText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text;
  // Naive truncation — cut in half and try again
  let truncated = text.slice(0, Math.floor(text.length / 2));
  while (Buffer.byteLength(truncated + "\n\n[...truncated]", "utf-8") > maxBytes) {
    truncated = truncated.slice(0, Math.floor(truncated.length * 0.9));
  }
  return truncated + "\n\n[...truncated]";
}

function appendHandoffMessage(text: string, message: string, maxBytes: number): string {
  const suffix = `\n\n${message}`;
  const suffixBytes = Buffer.byteLength(suffix, "utf-8");
  const previewBytes = Math.max(1_000, maxBytes - suffixBytes);
  return `${truncateText(text, previewBytes)}${suffix}`;
}

function formatSgFailure(action: string, code: number, stdout: string, stderr: string): string {
  return truncateText(
    `ast-grep ${action} failed (exit ${code}):\n${stderr || stdout || "unknown error"}`,
    40_000,
  );
}

function parseJsonArrayOutput(stdout: string): { parsed: unknown[]; parseFailed: boolean } {
  if (!stdout.trim()) return { parsed: [], parseFailed: false };

  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed)
      ? { parsed, parseFailed: false }
      : { parsed: [], parseFailed: true };
  } catch {
    try {
      const lines = stdout.trim().split("\n").filter(Boolean);
      return { parsed: lines.map((line) => JSON.parse(line)), parseFailed: false };
    } catch {
      return { parsed: [], parseFailed: true };
    }
  }
}

async function saveFullResults(cwd: string, fileName: string, results: unknown[]): Promise<string> {
  const outputDir = join(cwd, ".pi", "extensions");
  await mkdir(outputDir, { recursive: true });
  const filePath = join(outputDir, fileName);
  await writeFile(filePath, JSON.stringify(results, null, 2), "utf-8");
  return filePath;
}

/** Find sgconfig.yml walking up from a directory. */
async function findSgConfig(cwd: string): Promise<string | null> {
  let dir = resolve(cwd);
  const root = resolve("/");
  while (dir !== root) {
    const configPath = resolve(dir, "sgconfig.yml");
    try {
      await access(configPath, constants.R_OK);
      return configPath;
    } catch {
      // also try sgconfig.yaml
      const altPath = resolve(dir, "sgconfig.yaml");
      try {
        await access(altPath, constants.R_OK);
        return altPath;
      } catch {
        // continue
      }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function piSimpleAstGrepExtension(pi: ExtensionAPI) {
  let sgAvailable = false;

  // Throws if sg is not installed
  async function ensureSg(signal?: AbortSignal): Promise<string> {
    if (sgAvailable && sgResolvedInvocation) return sgResolvedInvocation.command;
    const invocation = await findSgBinary(signal);
    if (!invocation) {
      throw new Error(
        "ast-grep CLI not found. Install it: npm install -g @ast-grep/cli",
      );
    }
    sgResolvedInvocation = invocation;
    sgAvailable = true;
    return invocation.command;
  }

  // ── Tool: ast_grep_search ──────────────────────────────────────────────

  pi.registerTool({
    name: "ast_grep_search",
    label: "AST Grep Search",
    description:
      "Structural code search using AST patterns. Finds code matching a structural pattern " +
      "(not regex). Use when grep/regex is imprecise for code structure — e.g., finding " +
      "all function calls with a specific shape, locating assignments to a pattern, or " +
      "searching for code that follows a particular AST structure across a codebase.",
    promptSnippet:
      "Structural code search using AST patterns (tree-sitter based). More precise than regex for code structure.",
    promptGuidelines: [
      "Prefer ast_grep_search over grep when searching for code structures (function calls, class patterns, conditional patterns) rather than literal text.",
      "Use metavariables like $VAR, $FN, $ARG to make patterns flexible. e.g., '$FN($$$ARGS)' matches any function call.",
      "Set language explicitly when the file extension is ambiguous or the pattern uses language-specific syntax.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "AST pattern to search for. Looks like regular code. Use $VAR metavariables for holes. " +
          "Use $$$ for ellipsis (match any sequence). Examples: '$FN($$$ARGS)', 'const $X = $Y', " +
          "'$OBJ.$METHOD()'",
      }),
      language: Type.Optional(
        Type.String({
          description:
            "Language of the pattern (e.g., ts, js, py, rs, go, java). Auto-detected from file extensions if omitted.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "File or directory path to search. Defaults to current working directory.",
        }),
      ),
      glob: Type.Optional(
        Type.String({
          description: "File glob pattern to filter (e.g., 'src/**/*.ts').",
        }),
      ),
      contextLines: Type.Optional(
        Type.Number({
          description: "Number of context lines to show before/after each match (default: 2).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await ensureSg(signal);
      const args: string[] = ["run", "--pattern", params.pattern, "--json"];

      if (params.language) args.push("--lang", params.language);
      if (params.glob) args.push("--globs", params.glob);

      const contextLines = params.contextLines ?? 2;
      if (!Number.isInteger(contextLines) || contextLines < 0) {
        return {
          content: [{ type: "text", text: "contextLines must be a non-negative integer." }],
          details: { error: true, contextLines },
        };
      }
      if (contextLines > 0) args.push("--context", String(contextLines));

      const searchPath = params.path ?? ".";
      args.push(searchPath);

      try {
        const [cmd, cmdArgs] = buildSgArgs(args);
        const { stdout, stderr, code } = await execAsync(cmd, cmdArgs, {
          cwd: ctx.cwd,
          timeout: 60_000,
          signal,
        });

        if (code !== 0 && !stdout.trim()) {
          return {
            content: [
              {
                type: "text",
                text: `ast-grep search failed (exit ${code}):\n${stderr || "unknown error"}`,
              },
            ],
            details: { exitCode: code, pattern: params.pattern },
          };
        }

        // Parse JSON output (--json returns a JSON array)
        let parsed: unknown[] = [];
        let parseFailed = false;
        try {
          parsed = JSON.parse(stdout);
          if (!Array.isArray(parsed)) parsed = [];
        } catch {
          // Fall back to line-by-line parsing
          try {
            const lines = stdout.trim().split("\n").filter(Boolean);
            parsed = lines.map((l) => JSON.parse(l));
          } catch {
            parseFailed = stdout.trim().length > 0;
          }
        }

        if (parseFailed) {
          return {
            content: [
              {
                type: "text",
                text: truncateText(
                  `ast-grep search returned non-JSON output.\n\nstdout:\n${stdout || "(empty)"}\n\nstderr:\n${stderr || "(empty)"}`,
                  40_000,
                ),
              },
            ],
            details: { error: true, parseFailed: true, exitCode: code, pattern: params.pattern },
          };
        }

        if (parsed.length === 0) {
          return {
            content: [
              { type: "text", text: `No matches found for pattern: \`${params.pattern}\`` },
            ],
            details: { matchCount: 0, pattern: params.pattern },
          };
        }

        // Format results
        const outputLines: string[] = [
          `Found ${parsed.length} match(es) for pattern: \`${params.pattern}\``,
          "",
        ];

        for (let i = 0; i < Math.min(parsed.length, 50); i++) {
          const m = parsed[i] as Record<string, unknown>;
          const file = m.file ?? "unknown";
          const range = m.range as Record<string, unknown> | undefined;
          const start = range?.start as Record<string, unknown> | undefined;
          const line = start?.line ?? m.line ?? m.startLine ?? "?";
          const col = start?.column ?? m.column ?? m.startColumn ?? "?";
          const text = (m.lines ?? m.text ?? m.matchText ?? "").toString().trim();
          outputLines.push(`  ${file}:${line}:${col}`);
          if (text) outputLines.push(`    ${text}`);
        }

        let handoffMessage: string | undefined;
        if (parsed.length > 50) {
          const fullResultsPath = await saveFullResults(
            ctx.cwd,
            ".pi-ast-grep-search-results.json",
            parsed,
          );
          handoffMessage = `Full results saved to ${fullResultsPath}. Use read_file or ctx_execute to analyze the complete JSON output.`;
          outputLines.push(`  ... and ${parsed.length - 50} more matches (use glob to narrow)`);
        }

        const preview = outputLines.join("\n");
        const result = handoffMessage
          ? appendHandoffMessage(preview, handoffMessage, 40_000)
          : truncateText(preview, 40_000);

        return {
          content: [{ type: "text", text: result }],
          details: {
            matchCount: parsed.length,
            pattern: params.pattern,
            truncated: parsed.length > 50,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `ast-grep search error: ${msg}` }],
          details: { error: true },
        };
      }
    },
  });

  // ── Tool: ast_grep_scan ────────────────────────────────────────────────

  pi.registerTool({
    name: "ast_grep_scan",
    label: "AST Grep Scan",
    description:
      "Run ast-grep rule-based scanning. Uses rules defined in sgconfig.yml or inline YAML rules " +
      "to lint/check code. Can also apply auto-fixes when available. Use to check code quality " +
      "against project-specific rules, or to scan with a specific rule file.",
    promptSnippet:
      "Run ast-grep rule-based scan (YAML rules). Checks code against project or inline rules with optional auto-fix.",
    promptGuidelines: [
      "Use ast_grep_scan to check code against project rules defined in sgconfig.yml.",
      "Use the inlineRules parameter to pass a quick one-off YAML rule without creating a file.",
      "Set applyFixes: true to automatically apply rewrites from rules that have fix patterns.",
    ],
    parameters: Type.Object({
      ruleFile: Type.Optional(
        Type.String({
          description: "Path to a single rule YAML file. If omitted, uses sgconfig.yml from project root.",
        }),
      ),
      inlineRules: Type.Optional(
        Type.String({
          description:
            "Inline YAML rule text (alternative to ruleFile). Example:\n" +
            "id: no-console-log\nlanguage: TypeScript\nrule:\n  pattern: console.log($$$)\nmessage: remove debug log\nseverity: warning",
        }),
      ),
      ruleFilter: Type.Optional(
        Type.String({
          description: "Regex to filter which rules to run (by rule id).",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "File or directory to scan. Defaults to current working directory.",
        }),
      ),
      applyFixes: Type.Optional(
        Type.Boolean({
          description: "Apply auto-fixes for rules that have fix patterns. Default: false (report only).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await ensureSg(signal);
      const args: string[] = ["scan", "--json"];

      if (params.ruleFile) {
        args.push("--rule", params.ruleFile);
      } else if (params.inlineRules) {
        args.push("--inline-rules", params.inlineRules);
      } else {
        // Try to find sgconfig.yml
        const configPath = await findSgConfig(ctx.cwd);
        if (configPath) {
          args.push("--config", configPath);
        } else {
          return {
            content: [
              {
                type: "text",
                text:
                  "No sgconfig.yml found in project and no ruleFile or inlineRules provided. " +
                  "Create an sgconfig.yml or pass --rule / --inline-rules.",
              },
            ],
            details: {},
          };
        }
      }

      if (params.ruleFilter) args.push("--filter", params.ruleFilter);
      if (params.applyFixes) args.push("--update-all");

      const scanPath = params.path ?? ".";
      args.push(scanPath);

      try {
        const [cmd, cmdArgs] = buildSgArgs(args);
        const { stdout, stderr, code } = await execAsync(cmd, cmdArgs, {
          cwd: ctx.cwd,
          timeout: 120_000,
          signal,
        });

        if (code !== 0 && !stdout.trim()) {
          return {
            content: [{ type: "text", text: formatSgFailure("scan", code, stdout, stderr) }],
            details: { error: true, exitCode: code },
          };
        }

        // scan returns exit code > 0 when violations found — that's expected
        const { parsed: violations, parseFailed } = parseJsonArrayOutput(stdout);

        if (parseFailed) {
          return {
            content: [
              {
                type: "text",
                text: truncateText(
                  `ast-grep scan returned non-JSON output.\n\nstdout:\n${stdout || "(empty)"}\n\nstderr:\n${stderr || "(empty)"}`,
                  40_000,
                ),
              },
            ],
            details: { error: true, parseFailed: true, exitCode: code },
          };
        }

        if (violations.length === 0) {
          const action = params.applyFixes ? "Fixed. No remaining violations." : "No violations found.";
          return {
            content: [{ type: "text", text: `ast-grep scan: ${action}` }],
            details: { violationCount: 0 },
          };
        }

        // Summarize violations
        const byRule = new Map<string, number>();
        for (const v of violations) {
          const ruleId = (v as Record<string, unknown>).ruleId ?? (v as Record<string, unknown>).rule_id ?? "unknown";
          byRule.set(String(ruleId), (byRule.get(String(ruleId)) ?? 0) + 1);
        }

        const summary = [
          `Found ${violations.length} violation(s):`,
          "",
        ];
        for (const [rule, count] of byRule) {
          summary.push(`  ${rule}: ${count}`);
        }
        summary.push("");

        // Show first 20 violations
        for (let i = 0; i < Math.min(violations.length, 20); i++) {
          const v = violations[i] as Record<string, unknown>;
          const file = v.file ?? "?";
          const range = v.range as Record<string, unknown> | undefined;
          const start = range?.start as Record<string, unknown> | undefined;
          const line = start?.line ?? v.line ?? v.startLine ?? "?";
          const message = v.message ?? "";
          const ruleId = v.ruleId ?? v.rule_id ?? "";
          summary.push(`  ${file}:${line}  [${ruleId}] ${message}`);
        }

        let handoffMessage: string | undefined;
        if (violations.length > 20) {
          const fullResultsPath = await saveFullResults(
            ctx.cwd,
            ".pi-ast-grep-scan-results.json",
            violations,
          );
          handoffMessage = `Full results saved to ${fullResultsPath}. Use read_file or ctx_execute to analyze the complete JSON output.`;
          summary.push(`  ... and ${violations.length - 20} more`);
        }

        const action = params.applyFixes
          ? "Scan with auto-fix applied. Remaining violations:"
          : "Scan results:";
        const preview = `${action}\n${summary.join("\n")}`;
        const result = handoffMessage
          ? appendHandoffMessage(preview, handoffMessage, 40_000)
          : truncateText(preview, 40_000);

        return {
          content: [{ type: "text", text: result }],
          details: {
            violationCount: violations.length,
            byRule: Object.fromEntries(byRule),
            exitCode: code,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `ast-grep scan error: ${msg}` }],
          details: { error: true },
        };
      }
    },
  });

  // ── Tool: ast_grep_rewrite ────────────────────────────────────────────

  pi.registerTool({
    name: "ast_grep_rewrite",
    label: "AST Grep Rewrite",
    description:
      "Structural code search-and-replace using AST patterns. Finds code matching a structural " +
      "pattern and replaces it with a rewrite template. Defaults to dry-run (preview only). " +
      "Set apply: true to write changes directly to files. Use for: mass refactoring, " +
      "migrating deprecated APIs, renaming patterns across a codebase.",
    promptSnippet:
      "Structural search-and-replace using AST patterns. Dry-run by default; set apply:true to write.",
    promptGuidelines: [
      "Use ast_grep_rewrite for mass find-and-replace where edit would require dozens of individual calls.",
      "Always run ast_grep_rewrite with apply: false first to preview changes, then re-run with apply: true.",
      "Use metavariables from the pattern in the rewrite. E.g., pattern: '($OLD).$METHOD()', rewrite: '$OLD?.$METHOD()'.",
    ],
    parameters: Type.Object({
      pattern: Type.String({
        description:
          "AST pattern to find. Uses $VAR metavariables. Example: 'assertEquals($EXPECTED, $ACTUAL)'",
      }),
      rewrite: Type.String({
        description:
          "Replacement template. Metavariables from the pattern are available. " +
          "Example: 'assertThat($ACTUAL).isEqualTo($EXPECTED)'",
      }),
      language: Type.Optional(
        Type.String({
          description: "Language of the pattern. Auto-detected from file extensions if omitted.",
        }),
      ),
      path: Type.Optional(
        Type.String({
          description: "File or directory to rewrite. Defaults to current working directory.",
        }),
      ),
      glob: Type.Optional(
        Type.String({
          description: "File glob to filter (e.g., 'src/**/*.kt').",
        }),
      ),
      apply: Type.Optional(
        Type.Boolean({
          description:
            "Actually write changes to files. Default: false (dry-run — preview only).",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      await ensureSg(signal);
      const args: string[] = ["run", "--pattern", params.pattern, "--rewrite", params.rewrite, "--json"];

      if (params.language) args.push("--lang", params.language);
      if (params.glob) args.push("--globs", params.glob);
      if (params.apply) args.push("--update-all");

      const searchPath = params.path ?? ".";
      args.push(searchPath);

      try {
        const [cmd, cmdArgs] = buildSgArgs(args);
        const { stdout, stderr, code } = await execAsync(cmd, cmdArgs, {
          cwd: ctx.cwd,
          timeout: 60_000,
          signal,
        });

        if (code !== 0 && !stdout.trim()) {
          return {
            content: [{ type: "text", text: formatSgFailure("rewrite", code, stdout, stderr) }],
            details: { error: true, exitCode: code, pattern: params.pattern, rewrite: params.rewrite },
          };
        }

        // Parse JSON output
        const { parsed, parseFailed } = parseJsonArrayOutput(stdout);

        if (parseFailed) {
          return {
            content: [
              {
                type: "text",
                text: truncateText(
                  `ast-grep rewrite returned non-JSON output.\n\nstdout:\n${stdout || "(empty)"}\n\nstderr:\n${stderr || "(empty)"}`,
                  40_000,
                ),
              },
            ],
            details: {
              error: true,
              parseFailed: true,
              exitCode: code,
              pattern: params.pattern,
              rewrite: params.rewrite,
            },
          };
        }

        const applied = params.apply === true;
        const action = applied ? "Applied" : "Would apply (dry-run — use apply:true to write)";

        if (parsed.length === 0) {
          return {
            content: [{ type: "text", text: `No matches found for pattern: \`${params.pattern}\`` }],
            details: { matchCount: 0, pattern: params.pattern, rewrite: params.rewrite },
          };
        }

        // Format preview
        const outputLines: string[] = [
          `${action} ${parsed.length} rewrite(s) for: \`${params.pattern}\` → \`${params.rewrite}\``,
          "",
        ];

        for (let i = 0; i < Math.min(parsed.length, 30); i++) {
          const m = parsed[i] as Record<string, unknown>;
          const file = m.file ?? "?";
          const range = m.range as Record<string, unknown> | undefined;
          const start = range?.start as Record<string, unknown> | undefined;
          const line = start?.line ?? "?";
          outputLines.push(`  ${file}:${line}`);
          outputLines.push(`    - ${m.text}`);
          outputLines.push(`    + ${m.replacement}`);
          outputLines.push("");
        }

        let handoffMessage: string | undefined;
        if (parsed.length > 30) {
          const fullResultsPath = await saveFullResults(
            ctx.cwd,
            ".pi-ast-grep-rewrite-results.json",
            parsed,
          );
          handoffMessage = `Full results saved to ${fullResultsPath}. Use read_file or ctx_execute to analyze the complete JSON output.`;
          outputLines.push(`  ... and ${parsed.length - 30} more rewrites`);
        }

        const preview = outputLines.join("\n");
        const result = handoffMessage
          ? appendHandoffMessage(preview, handoffMessage, 40_000)
          : truncateText(preview, 40_000);

        return {
          content: [{ type: "text", text: result }],
          details: {
            matchCount: parsed.length,
            pattern: params.pattern,
            rewrite: params.rewrite,
            applied,
          },
        };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `ast-grep rewrite error: ${msg}` }],
          details: { error: true },
        };
      }
    },
  });

  // ── Hook: Auto-validate edits against project rules ────────────────────

  pi.on("tool_result", async (event, ctx) => {
    // Only hook into edit/write tools
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    if (event.isError) return;

    // Check if sg is available and a config exists
    if (!sgAvailable) {
      try { await ensureSg(ctx.signal); } catch { return; }
    }

    const configPath = await findSgConfig(ctx.cwd);
    if (!configPath) return; // No project rules, skip

    // Get the file path from the tool input
    const input = event.input as { path?: string };
    const filePath = input?.path;
    if (!filePath) return;

    // Only validate source files (skip json, yaml, toml, md unless those have rules)
    const resolvedPath = resolve(ctx.cwd, filePath);
    const configDir = dirname(configPath);
    const relativeToConfig = relative(configDir, resolvedPath);
    if (relativeToConfig.startsWith("..") || isAbsolute(relativeToConfig)) return; // Only files within config scope

    // Run sg scan on just this file
    try {
      const [cmd, cmdArgs] = buildSgArgs(["scan", "--config", configPath, "--json", resolvedPath]);
      const { stdout } = await execAsync(
        cmd, cmdArgs,
        { cwd: ctx.cwd, timeout: 30_000, signal: ctx.signal },
      );

      let violations: unknown[] = [];
      try {
        violations = JSON.parse(stdout);
        if (!Array.isArray(violations)) violations = [];
      } catch {
        violations = stdout.trim().split("\n").filter(Boolean).map((l: string) => {
          try { return JSON.parse(l); } catch { return l; }
        });
      }
      if (violations.length === 0) return; // Clean

      // Report violations as a non-blocking notification
      const count = violations.length;
      const ids = new Set<string>();
      for (const v of violations) {
        try {
          const parsed = typeof v === 'object' ? v as Record<string, unknown> : JSON.parse(String(v));
          ids.add(String(parsed.ruleId ?? parsed.rule_id ?? "unknown"));
        } catch { /* skip */ }
      }

      // Inject a follow-up message for the LLM
      pi.sendMessage(
        {
          customType: "pi-simple-ast-grep",
          content: `⚠️ pi-simple-ast-grep found ${count} ast-grep violation(s) in \`${filePath}\` for rules: ${[...ids].join(", ")}. Run ast_grep_scan to see details and optionally apply fixes.`,
          display: true,
        },
        { deliverAs: "followUp" },
      );
    } catch {
      // Silently ignore validation errors in hooks
    }
  });

  // ── Startup check ──────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      await ensureSg();
      ctx.ui.notify("pi-simple-ast-grep: sg binary found", "info");
    } catch {
      ctx.ui.notify(
        "pi-simple-ast-grep: sg not installed. Install with: npm install -g @ast-grep/cli",
        "warn",
      );
    }
  });
}
