// End-to-end pipeline: Stage 0 (fetch) → Stage 1 (per-book summary) → Stage 2 (portrait).
// Emits progress events via a callback so the HTTP layer can stream them to the client.

import {
  getShelf, buildPrivateBookSet, getAllNotebooks,
  getBookmarks, getMyReviews, getReadDetail, pMap,
  type NotebookBook,
} from "./weread.ts";
import { compressBook } from "./compress.ts";
import { complete, completeStream, type DeepSeekConfig } from "./deepseek.ts";
import { STAGE1_SYSTEM, stage1User, STAGE2_SYSTEM, stage2User } from "./prompts.ts";

export interface Stage01Result {
  summaries: Array<{ title: string; author: string; summary: any }>;
  meta: {
    totalBooks: number;
    privateExcluded: number;
    totalBookmarks: number;
    totalThoughts: number;
    selectedCount: number;
  };
  readStats: any;
}

export type ProgressEvent =
  | { type: "status"; message: string }
  | { type: "progress"; current: number; total: number; bookTitle?: string }
  | { type: "meta"; totalBooks: number; privateExcluded: number; totalBookmarks: number; totalThoughts: number; selectedCount: number }
  | { type: "summaries"; data: Stage01Result }
  | { type: "portrait_delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type Emit = (e: ProgressEvent) => void;

export interface RunOptions {
  wereadKey: string;
  tier: "lt20" | "20" | "30" | "40" | "50";
  deepseek: DeepSeekConfig;
  emit: Emit;
}

function tierToN(tier: RunOptions["tier"]): number {
  if (tier === "lt20") return 19; // cap at 19 for the <20 tier; pipeline always uses min(N, available)
  return parseInt(tier, 10);
}

// ---------- Stage 0+1: fetch, compress, per-book summary ----------

export interface RunStage01Options {
  wereadKey: string;
  count: number;
  deepseek: DeepSeekConfig;
  emit: Emit;
}

export async function runStage01(opts: RunStage01Options): Promise<void> {
  const { wereadKey, count, deepseek, emit } = opts;
  try {
    // ---- Stage 0a: shelf for privacy filter ----
    emit({ type: "status", message: "正在读取书架..." });
    const shelf = await getShelf(wereadKey);
    const privateSet = buildPrivateBookSet(shelf);

    // ---- Stage 0b: notebooks metadata ----
    emit({ type: "status", message: "正在读取笔记本列表..." });
    const allNotebooks = await getAllNotebooks(wereadKey);

    const beforePrivacy = allNotebooks.length;
    let candidates = allNotebooks.filter(nb => !privateSet.has(nb.bookId));
    const privateExcluded = beforePrivacy - candidates.length;

    candidates = candidates.filter(nb => (nb.noteCount + nb.reviewCount) > 0);
    candidates.sort((a, b) => (b.noteCount + b.reviewCount) - (a.noteCount + a.reviewCount));
    const selected = candidates.slice(0, count);

    emit({
      type: "status",
      message: `发现 ${allNotebooks.length} 本带笔记的书，已排除 ${privateExcluded} 本私密阅读，本次将分析 ${selected.length} 本。`,
    });

    if (selected.length === 0) {
      emit({ type: "error", message: "你目前没有带划线或想法的非私密书籍，无法生成画像。" });
      return;
    }

    // ---- Stage 0c + 0d + Stage 1: pipelined per-book (fetch → compress → summarize) ----
    emit({ type: "status", message: `正在抓取并分析 ${selected.length} 本书...` });
    let doneCount = 0;
    let totalBookmarks = 0;
    let totalThoughts = 0;

    const summaries = await pMap(selected, async (nb: NotebookBook) => {
      const [bookmarks, thoughts] = await Promise.all([
        getBookmarks(wereadKey, nb.bookId).catch(() => null),
        getMyReviews(wereadKey, nb.bookId).catch(() => [] as any[]),
      ]);
      const book = compressBook(nb.book.title, nb.book.author, bookmarks, thoughts);
      totalBookmarks += book.totalBookmarks;
      totalThoughts += book.totalThoughts;
      try {
        const raw = await complete(
          deepseek,
          deepseek.flashModel,
          [
            { role: "system", content: STAGE1_SYSTEM },
            { role: "user", content: stage1User(book) },
          ],
          { temperature: 0.4, max_tokens: 800, response_format: "json" },
        );
        const parsed = safeJSON(raw) ?? {
          core_themes: "(解析失败)",
          emotional_tendency: "(解析失败)",
          thinking_style: "(解析失败)",
          notable_quotes: [],
        };
        doneCount++;
        emit({ type: "progress", current: doneCount, total: selected.length, bookTitle: nb.book.title });
        return { title: nb.book.title, author: nb.book.author, summary: parsed };
      } catch (e: any) {
        doneCount++;
        emit({ type: "progress", current: doneCount, total: selected.length, bookTitle: nb.book.title });
        return { title: nb.book.title, author: nb.book.author, summary: { error: (e as any).message } };
      }
    }, 8);

    const validSummaries = summaries.filter((s): s is NonNullable<typeof s> => s !== null);

    const meta = {
      totalBooks: allNotebooks.length,
      privateExcluded,
      totalBookmarks,
      totalThoughts,
      selectedCount: validSummaries.length,
    };
    emit({ type: "meta", ...meta });

    emit({
      type: "summaries",
      data: { summaries: validSummaries, meta, readStats: null },
    });
  } catch (e: any) {
    emit({ type: "error", message: e?.message || String(e) });
  }
}

// ---------- Stage 2: portrait synthesis ----------

export interface RunStage2Options {
  result: Stage01Result;
  deepseek: DeepSeekConfig;
  emit: Emit;
}

export async function runStage2(opts: RunStage2Options): Promise<void> {
  const { result, deepseek, emit } = opts;
  try {
    emit({ type: "status", message: "正在生成阅读人格画像..." });
    const stream = completeStream(
      deepseek,
      deepseek.proModel,
      [
        { role: "system", content: STAGE2_SYSTEM },
        {
          role: "user",
          content: stage2User({
            totalBooks: result.meta.selectedCount,
            privateExcluded: result.meta.privateExcluded,
            totalBookmarks: result.meta.totalBookmarks,
            totalThoughts: result.meta.totalThoughts,
            readStats: result.readStats,
            bookSummaries: result.summaries,
          }),
        },
      ],
      { temperature: 0.7, max_tokens: 4000 },
    );

    for await (const delta of stream) {
      emit({ type: "portrait_delta", text: delta });
    }

    emit({ type: "done" });
  } catch (e: any) {
    emit({ type: "error", message: e?.message || String(e) });
  }
}

// ---------- Legacy single-shot pipeline (kept for local test.ts) ----------

export async function run(opts: RunOptions): Promise<void> {
  const { wereadKey, tier, deepseek, emit } = opts;
  const targetN = tierToN(tier);

  let captured: Stage01Result | null = null;
  const captureEmit: Emit = (e) => {
    if (e.type === "summaries") {
      captured = e.data;
      return;
    }
    emit(e);
  };

  await runStage01({ wereadKey, count: targetN, deepseek, emit: captureEmit });
  if (!captured) return;
  await runStage2({ result: captured, deepseek, emit });
}

function safeJSON(s: string): any | null {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}
