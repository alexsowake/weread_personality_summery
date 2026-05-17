// End-to-end pipeline: Stage 0 (fetch) → Stage 1 (per-book summary) → Stage 2 (portrait).
// Emits progress events via a callback so the HTTP layer can stream them to the client.

import {
  getShelf, buildPrivateBookSet, getAllNotebooks,
  getBookmarks, getMyReviews, getReadDetail, pMap,
  type NotebookBook,
} from "./weread.ts";
import { compressBook, type CompressedBook } from "./compress.ts";
import { complete, completeStream, type DeepSeekConfig } from "./deepseek.ts";
import { STAGE1_SYSTEM, stage1User, STAGE2_SYSTEM, stage2User } from "./prompts.ts";

export type ProgressEvent =
  | { type: "status"; message: string }
  | { type: "progress"; current: number; total: number; bookTitle?: string }
  | { type: "meta"; totalBooks: number; privateExcluded: number; totalBookmarks: number; totalThoughts: number; selectedCount: number }
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

export async function run(opts: RunOptions): Promise<void> {
  const { wereadKey, tier, deepseek, emit } = opts;
  const targetN = tierToN(tier);

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
    const selected = candidates.slice(0, targetN);

    emit({
      type: "status",
      message: `发现 ${allNotebooks.length} 本带笔记的书，已排除 ${privateExcluded} 本私密阅读，本次将分析 ${selected.length} 本。`,
    });

    if (selected.length === 0) {
      emit({ type: "error", message: "你目前没有带划线或想法的非私密书籍，无法生成画像。" });
      return;
    }

    // ---- Stage 0c: fetch bookmarks + thoughts in parallel ----
    emit({ type: "status", message: "正在抓取每本书的划线和想法..." });
    let fetchedCount = 0;
    const fetched = await pMap(selected, async (nb: NotebookBook) => {
      const [bookmarks, thoughts] = await Promise.all([
        getBookmarks(wereadKey, nb.bookId).catch(() => null),
        getMyReviews(wereadKey, nb.bookId).catch(() => [] as any[]),
      ]);
      fetchedCount++;
      emit({
        type: "progress",
        current: fetchedCount,
        total: selected.length,
        bookTitle: nb.book.title,
      });
      return { nb, bookmarks, thoughts };
    }, 5);

    const valid = fetched.filter((x): x is NonNullable<typeof x> => x !== null);

    // ---- Stage 0d: compress each book ----
    const compressed: CompressedBook[] = valid.map(v =>
      compressBook(v.nb.book.title, v.nb.book.author, v.bookmarks, v.thoughts)
    );

    const totalBookmarks = compressed.reduce((s, c) => s + c.totalBookmarks, 0);
    const totalThoughts = compressed.reduce((s, c) => s + c.totalThoughts, 0);

    emit({
      type: "meta",
      totalBooks: allNotebooks.length,
      privateExcluded,
      totalBookmarks,
      totalThoughts,
      selectedCount: compressed.length,
    });

    // ---- Stage 1: per-book summary in parallel (Flash) ----
    emit({ type: "status", message: `正在用 AI 精读 ${compressed.length} 本书...` });
    let summarizedCount = 0;
    const summaries = await pMap(compressed, async (book) => {
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
        summarizedCount++;
        emit({
          type: "progress",
          current: summarizedCount,
          total: compressed.length,
          bookTitle: book.title,
        });
        return { title: book.title, author: book.author, summary: parsed };
      } catch (e: any) {
        summarizedCount++;
        emit({ type: "progress", current: summarizedCount, total: compressed.length, bookTitle: book.title });
        return { title: book.title, author: book.author, summary: { error: e.message } };
      }
    }, 6);

    const validSummaries = summaries.filter((s): s is NonNullable<typeof s> => s !== null);

    // ---- Optional: fetch reading stats ----
    const readStats = await getReadDetail(wereadKey).catch(() => null);

    // ---- Stage 2: portrait synthesis (Pro, streamed) ----
    emit({ type: "status", message: "正在生成阅读人格画像..." });
    const stream = completeStream(
      deepseek,
      deepseek.proModel,
      [
        { role: "system", content: STAGE2_SYSTEM },
        {
          role: "user",
          content: stage2User({
            totalBooks: compressed.length,
            privateExcluded,
            totalBookmarks,
            totalThoughts,
            readStats,
            bookSummaries: validSummaries,
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

function safeJSON(s: string): any | null {
  try { return JSON.parse(s); } catch {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
  }
  return null;
}
