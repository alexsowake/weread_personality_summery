// Per-book content pre-compression (Stage 0d).
// Goal: cap each book at ~3000 chars while preserving the highest-signal content
// for personality analysis. Priority:
//   1. all thoughts/reviews (user-authored content, highest signal)
//   2. highlights that have an associated thought (double-confirmed interest)
//   3. remaining highlights, sampled evenly across chapters

import type { Bookmark, BookmarkListResponse, Thought } from "./weread.ts";

const PER_BOOK_CHAR_BUDGET = 3000;

export interface CompressedBook {
  title: string;
  author: string;
  totalBookmarks: number;
  totalThoughts: number;
  text: string;
}

export function compressBook(
  title: string,
  author: string,
  bookmarks: BookmarkListResponse | null,
  thoughts: Thought[],
): CompressedBook {
  const marks = bookmarks?.updated ?? [];
  const chapters = new Map<number, string>();
  for (const c of bookmarks?.chapters ?? []) chapters.set(c.chapterUid, c.title);

  // Set of bookmark ranges that have associated thoughts
  const thoughtRanges = new Set<string>();
  for (const t of thoughts) {
    if (t.range) thoughtRanges.add(t.range);
  }

  const lines: string[] = [];
  let used = 0;
  const remaining = () => PER_BOOK_CHAR_BUDGET - used;
  const push = (line: string) => {
    if (used + line.length + 1 > PER_BOOK_CHAR_BUDGET) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };

  // Priority 1: thoughts (user-written content)
  push("【想法/点评】");
  for (const t of thoughts) {
    if (!t.content?.trim()) continue;
    const ctx = t.abstract ? `（针对划线："${truncate(t.abstract, 80)}"）` : "";
    const line = `- ${ctx}${t.content.trim()}`;
    if (!push(line)) break;
  }

  // Priority 2: highlights with associated thought
  if (remaining() > 100) {
    push("【附带想法的划线】");
    for (const m of marks) {
      if (!thoughtRanges.has(m.range)) continue;
      const ch = chapters.get(m.chapterUid);
      const line = `- ${ch ? `[${ch}] ` : ""}${m.markText.trim()}`;
      if (!push(line)) break;
    }
  }

  // Priority 3: remaining highlights, sampled evenly across chapters
  if (remaining() > 100) {
    push("【其他划线】");
    const rest = marks.filter(m => !thoughtRanges.has(m.range));
    // Group by chapter, then interleave
    const byChapter = new Map<number, Bookmark[]>();
    for (const m of rest) {
      if (!byChapter.has(m.chapterUid)) byChapter.set(m.chapterUid, []);
      byChapter.get(m.chapterUid)!.push(m);
    }
    const buckets = Array.from(byChapter.values());
    let idx = 0;
    let done = false;
    while (!done) {
      done = true;
      for (const bucket of buckets) {
        if (idx < bucket.length) {
          done = false;
          const m = bucket[idx];
          const ch = chapters.get(m.chapterUid);
          const line = `- ${ch ? `[${ch}] ` : ""}${m.markText.trim()}`;
          if (!push(line)) { done = true; break; }
        }
      }
      idx++;
    }
  }

  if (marks.length + thoughts.length > 0) {
    const noteCount = marks.length;
    const includedHighlights = lines.filter(l => l.startsWith("- ") && !l.includes("：")).length;
    if (noteCount > includedHighlights) {
      push(`（本书共划线 ${noteCount} 条、想法 ${thoughts.length} 条，已节选信息量最高的内容用于分析）`);
    }
  }

  return {
    title,
    author,
    totalBookmarks: marks.length,
    totalThoughts: thoughts.length,
    text: lines.join("\n"),
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
