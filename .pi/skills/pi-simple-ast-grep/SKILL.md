---
name: pi-simple-ast-grep
description: Simple structural code search, linting, and rewriting using ast-grep AST patterns (tree-sitter based). Use when you need to find or rewrite code structures (function calls, class patterns, assignments, imports) across a codebase more precisely than regex/grep. Also use to scan code against custom project rules defined in sgconfig.yml.
license: MIT
compatibility: Requires ast-grep CLI (npm install -g @ast-grep/cli)
---

# pi-simple-ast-grep

pi-simple-ast-grep is a simple pi package for the ast-grep structural code search and rewriting tool. ast-grep matches code based on AST (abstract syntax tree), not text. This makes it dramatically more precise than grep/regex for code structures.

## When to Use

- **Searching code structures**: Find all function calls matching a shape, all class declarations with a specific pattern, all import statements, etc.
- **Mass refactoring**: Apply the same structural rewrite across hundreds of files.
- **Code audits**: Scan a codebase against custom rules (e.g., "no console.log in production code", "all API calls must use our wrapper").
- **Replacing regex-based searches**: When grep/regex misses code due to formatting differences (whitespace, line breaks, comments).

## Tools Available

This skill registers three custom tools:

| Tool | Purpose |
|------|---------|
| `ast_grep_search` | Structural search with AST patterns |
| `ast_grep_rewrite` | Structural find-and-replace (dry-run by default, set apply:true to write) |
| `ast_grep_scan` | Rule-based scanning (YAML rules, optional auto-fix) |

## Pattern Syntax

ast-grep patterns look like ordinary code, with metavariables as placeholders:

| Syntax | Meaning |
|--------|---------|
| `$VAR` | Matches any single AST node |
| `$$$` | Ellipsis — matches any sequence of nodes (including zero) |
| `$FN($$$ARGS)` | Matches any function call, capturing the function name and arguments |
| `const $NAME = $VALUE` | Matches any const declaration |
| `$OBJ.$METHOD()` | Matches any method call on any object |

### Example Patterns

```javascript
// Find all console.log calls
console.log($$$)

// Find all React useState calls
const [$STATE, $SETTER] = useState($INITIAL)

// Find all try/catch blocks (any language)
try { $$$ } catch($ERR) { $$$ }

// Find all .then().catch() promise chains
$PROMISE.then($FN).catch($FN2)

// Find unsafe type assertions in TypeScript
$EXPR as $TYPE
```

## Using with sgconfig.yml

If your project has an `sgconfig.yml`, the `ast_grep_scan` tool auto-discovers it. The `tool_result` hook also auto-validates edits against project rules.

Example `sgconfig.yml`:

```yaml
ruleDirs:
  - rules

rules:
  - id: no-console-log
    language: TypeScript
    severity: warning
    message: "Use logger instead of console.log"
    rule:
      pattern: console.log($$$)

  - id: prefer-optional-chain
    language: TypeScript
    severity: hint
    message: "Use optional chaining"
    rule:
      pattern: $A && $A.$B
    fix: $A?.$B
```

## Prerequisites

Install the CLI:

```bash
npm install -g @ast-grep/cli
# or: brew install ast-grep
# or: cargo install ast-grep --locked
# or: pip install ast-grep-cli
```

## Tips

1. **Start with search before rewrite**: Use `ast_grep_search` to find matches, then use `edit` tools for surgical changes, or `ast_grep_scan` with `applyFixes: true` for bulk fixes.
2. **Be specific with language**: Always set `language` when the file extension is ambiguous or you're searching across mixed-language projects.
3. **Use `glob` to scope searches**: Narrow searches to `src/**/*.ts` or `lib/**/*.py` for faster results.
4. **Inline rules for one-offs**: Use `inlineRules` in `ast_grep_scan` to define quick lint checks without creating files.
5. **Use saved JSON for large results**: If previews exceed limits, complete arrays are saved to `.pi/extensions/.pi-ast-grep-search-results.json`, `.pi/extensions/.pi-ast-grep-scan-results.json`, or `.pi/extensions/.pi-ast-grep-rewrite-results.json` in the project workspace. Use `ctx_execute` or a shell execution tool to run a short script (e.g., Python, Node, or jq) to aggregate and filter these large files. If no code execution tools are available, use read_file with strict line limits to inspect them safely.
6. **Always preview rewrites**: Run `ast_grep_rewrite` without `apply: true` first. Verify the proposed changes in the output, and only re-run with `apply: true` once confirmed.