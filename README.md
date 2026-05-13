# pi-simple-ast-grep

Simple pi package for structural code search, linting, and rewriting with [ast-grep](https://ast-grep.github.io/).

## What it provides

- `ast_grep_search` — search AST patterns across files.
- `ast_grep_rewrite` — preview or apply structural rewrites.
- `ast_grep_scan` — run ast-grep YAML rules or project `sgconfig.yml`.
- Edit/write auto-validation hook when a project has `sgconfig.yml` or `sgconfig.yaml`.

## Requirements

Install ast-grep CLI with one of:

```bash
npm install -g @ast-grep/cli
brew install ast-grep
cargo install ast-grep --locked
pip install ast-grep-cli
```

The extension discovers `sg`, `ast-grep`, Windows npm shims, and installed package binaries. It intentionally does not use `npx`; `@ast-grep/cli` exposes extensionless native binaries that npm/npx can execute incorrectly on Windows.

## Install in pi

Install from GitHub:

```bash
pi install git:github.com/SkipXS/pi-simple-ast-grep
```

Or project-local (`.pi/`):

```bash
pi install -l git:github.com/SkipXS/pi-simple-ast-grep
```

Test without installing:

```bash
pi -e ./extensions/pi-simple-ast-grep.ts
```

## Usage examples

Search:

```text
Use ast_grep_search with pattern: assertEquals($EXPECTED, $ACTUAL), language: kotlin, path: test
```

Dry-run rewrite:

```text
Use ast_grep_rewrite with pattern: assertEquals($EXPECTED, $ACTUAL), rewrite: assertThat($ACTUAL).isEqualTo($EXPECTED), language: kotlin, path: test, apply: false
```

Inline scan:

```yaml
id: no-assert-equals
language: Kotlin
severity: warning
message: prefer assertThat
rule:
  pattern: assertEquals($EXPECTED, $ACTUAL)
```

## Large result handoff

When ast-grep returns more items than the context preview limit, the tools keep a short preview and save the complete parsed JSON array under the project-local `.pi/extensions/` directory:

- `ast_grep_search` over 50 matches → `.pi/extensions/.pi-ast-grep-search-results.json`
- `ast_grep_scan` over 20 violations → `.pi/extensions/.pi-ast-grep-scan-results.json`
- `ast_grep_rewrite` over 30 rewrites → `.pi/extensions/.pi-ast-grep-rewrite-results.json`

Use `read_file` or `ctx_execute` on the saved file when complete result analysis is needed.

## Package layout

- `extensions/pi-simple-ast-grep.ts` — package extension entrypoint.
- `SKILL.md` — package skill loaded by pi.
- `.pi/extensions/pi-simple-ast-grep.ts` — project-local extension copy for development.
- `.pi/skills/pi-simple-ast-grep/SKILL.md` — project-local skill copy for development.
- `test/GreetingServiceTest.kt` — sample fixture for tool smoke checks.

Keep `extensions/pi-simple-ast-grep.ts` and `.pi/extensions/pi-simple-ast-grep.ts` synchronized.

## Smoke checks

From this repository in pi, verify:

1. `ast_grep_search` finds `assertEquals($EXPECTED, $ACTUAL)` in `test/` with `language: kotlin`.
2. `ast_grep_rewrite` with `apply: false` previews five rewrites in `test/GreetingServiceTest.kt`.
3. `ast_grep_scan` with an inline Kotlin rule reports five violations.

No automated test script is currently defined in `package.json`.
