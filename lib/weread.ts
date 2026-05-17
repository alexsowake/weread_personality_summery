// WeRead Agent Gateway client.
// Reference: ~/.claude/skills/weread/{SKILL,notes,shelf,readdata}.md

const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.3";

export class WeReadError extends Error {
  constructor(message: string, public errcode?: number) {
    super(message);
  }
}

async function call<T = any>(apiKey: string, apiName: string, params: Record<string, any> = {}, retries = 1): Promise<T> {
  const body = { api_name: apiName, skill_version: SKILL_VERSION, ...params };
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(GATEWAY, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new WeReadError(`HTTP ${res.status} on ${apiName}`);
      const json = await res.json() as any;
      if (json.errcode && json.errcode !== 0) {
        throw new WeReadError(json.errmsg || `errcode ${json.errcode} on ${apiName}`, json.errcode);
      }
      return json as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ---- Types (subset of fields we actually use) ----

export interface ShelfBook {
  bookId: string;
  secret?: number; // 1 = private
}

export interface ShelfResponse {
  books: ShelfBook[];
  albums?: { bookId: string; albumInfoExtra?: { secret?: number } }[];
}

export interface NotebookBook {
  bookId: string;
  book: { title: string; author: string; cover?: string };
  reviewCount: number;
  noteCount: number;
  bookmarkCount: number;
  sort: number;
}

export interface NotebooksResponse {
  totalBookCount: number;
  totalNoteCount: number;
  hasMore: number;
  books: NotebookBook[];
}

export interface Bookmark {
  bookmarkId: string;
  chapterUid: number;
  markText: string;
  createTime: number;
  range: string;
}

export interface BookmarkListResponse {
  updated: Bookmark[];
  chapters: { chapterUid: number; chapterIdx: number; title: string }[];
}

export interface Thought {
  reviewId: string;
  content: string;
  createTime: number;
  star?: number;
  chapterName?: string;
  isFinish?: boolean;
  range?: string;
  chapterUid?: number;
  abstract?: string;
}

export interface MyReviewsResponse {
  reviews: { review: Thought }[];
  totalCount: number;
  hasMore: number;
  synckey: number;
}

// ---- High-level helpers ----

export async function getShelf(apiKey: string): Promise<ShelfResponse> {
  return call<ShelfResponse>(apiKey, "/shelf/sync");
}

export function buildPrivateBookSet(shelf: ShelfResponse): Set<string> {
  const set = new Set<string>();
  for (const b of shelf.books || []) {
    if (b.secret === 1) set.add(b.bookId);
  }
  for (const a of shelf.albums || []) {
    if (a.albumInfoExtra?.secret === 1) set.add(a.bookId);
  }
  return set;
}

export async function getAllNotebooks(apiKey: string): Promise<NotebookBook[]> {
  const all: NotebookBook[] = [];
  let lastSort: number | undefined = undefined;
  let totalKnown = Infinity;
  while (all.length < totalKnown) {
    const params: any = { count: 100 };
    if (lastSort !== undefined) params.lastSort = lastSort;
    const resp = await call<NotebooksResponse>(apiKey, "/user/notebooks", params);
    totalKnown = resp.totalBookCount;
    if (!resp.books?.length) break;
    all.push(...resp.books);
    if (!resp.hasMore) break;
    lastSort = resp.books[resp.books.length - 1].sort;
  }
  return all;
}

export async function getNotebooksTotal(apiKey: string): Promise<number> {
  const resp = await call<NotebooksResponse>(apiKey, "/user/notebooks", { count: 1 });
  return resp.totalBookCount;
}

export async function getBookmarks(apiKey: string, bookId: string): Promise<BookmarkListResponse> {
  return call<BookmarkListResponse>(apiKey, "/book/bookmarklist", { bookId });
}

export async function getMyReviews(apiKey: string, bookId: string): Promise<Thought[]> {
  const all: Thought[] = [];
  let synckey = 0;
  // hard cap pagination to avoid runaway loops on degenerate data
  for (let i = 0; i < 10; i++) {
    const resp = await call<MyReviewsResponse>(apiKey, "/review/list/mine", { bookid: bookId, count: 50, synckey });
    if (!resp.reviews?.length) break;
    all.push(...resp.reviews.map(r => r.review));
    if (!resp.hasMore) break;
    synckey = resp.synckey;
  }
  return all;
}

export async function getReadDetail(apiKey: string): Promise<any> {
  // Best-effort; if API changes name, swallow and return null.
  try {
    return await call(apiKey, "/readdetail", {});
  } catch {
    return null;
  }
}

// ---- Concurrency utility ----

export async function pMap<T, R>(items: T[], fn: (item: T, idx: number) => Promise<R>, concurrency: number): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
