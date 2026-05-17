# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # local dev server (EdgeOne Pages dev via wrangler-compatible CLI)
npm run deploy   # deploy to EdgeOne Pages
```

No build step — EdgeOne Pages compiles TypeScript at deploy time. No test suite in the MVP.

## Architecture

Single-page H5 app backed by EdgeOne Pages Edge Functions (Cloudflare Workers-compatible runtime).

**Request flow:**
1. Browser → `POST /api/check` → validates WeRead API Key, returns `totalBookCount`
2. Browser → `POST /api/analyze` → returns SSE stream of `ProgressEvent` JSON lines → browser renders portrait in real time

**Pipeline stages (all in `lib/pipeline.ts`):**
- **Stage 0a** — `getShelf()` → build a `Set<bookId>` of private books (`secret === 1`)
- **Stage 0b** — `getAllNotebooks()` paginated → filter out private + bookmark-only books → sort by `noteCount + reviewCount` desc → take top N (user's tier)
- **Stage 0c** — parallel fetch (concurrency 5) of `/book/bookmarklist` + `/review/list/mine` per book
- **Stage 0d** — `compressBook()` in `lib/compress.ts`: hard-cap each book at ~3000 chars, priority order: thoughts → highlights with associated thoughts → remaining highlights sampled evenly across chapters
- **Stage 1** — DeepSeek Flash × N (concurrency 6): structured JSON summary `{core_themes, emotional_tendency, thinking_style, notable_quotes}` per book
- **Stage 2** — DeepSeek Pro × 1, streamed: three-section Markdown portrait (书单结构 / 人格特质分析 / 人格类型推断)

**Key design decisions:**
- No LLM tool-use — WeRead data fetching is hardcoded deterministic code, not agent tool calls
- `skill_version: "1.0.3"` must be included in every WeRead Gateway request body (see `lib/weread.ts`)
- WeRead API parameters must be **flat in the JSON body** — never nested under `params` or `data`
- If WeRead responds with `upgrade_info`, the skill is outdated — update `SKILL_VERSION` in `lib/weread.ts`

**Environment variables (set in EdgeOne Pages dashboard):**
- `DEEPSEEK_API_KEY` — DeepSeek bearer token
- `DEEPSEEK_FLASH_MODEL` — model ID for Stage 1 (default: `deepseek-chat`)
- `DEEPSEEK_PRO_MODEL` — model ID for Stage 2 (default: `deepseek-reasoner`)

**WeRead API reference:** `~/.claude/skills/weread/` — canonical field definitions live there; `notes.md`, `shelf.md`, `readdata.md` are especially relevant. Do not guess field meanings — check those files first.

## Tier system

User picks how many books to analyze: `lt20` / `20` / `30` / `40` / `50`. After Key validation, `/api/check` returns `totalBookCount`; the frontend grays out tiers that exceed it. The pipeline always caps at `min(tier, actualAvailable)`.
