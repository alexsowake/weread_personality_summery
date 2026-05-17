// Local test runner — bypasses Edge Functions HTTP layer.
// Usage:
//   Add WEREAD_API_KEY=<your key> to .env, then:
//   node --experimental-strip-types --env-file=.env test.ts [stage]
//
// stage args: "0" | "1" | "full" (default: full)
//
// Stage 0 only: fetch WeRead data, print book list + sample compressed content
// Stage 1 only: stage 0 + per-book DeepSeek summaries (no portrait)
// Full (default): complete pipeline, prints portrait to stdout

import { run, type ProgressEvent } from "./lib/pipeline.ts";
import { getShelf, buildPrivateBookSet, getAllNotebooks, getBookmarks, getMyReviews } from "./lib/weread.ts";
import { compressBook } from "./lib/compress.ts";
import { complete } from "./lib/deepseek.ts";
import { STAGE1_SYSTEM, stage1User } from "./lib/prompts.ts";

const WEREAD_KEY = process.env.WEREAD_API_KEY ?? "";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? "";
const FLASH_MODEL = process.env.DEEPSEEK_FLASH_MODEL ?? "deepseek-chat";
const PRO_MODEL = process.env.DEEPSEEK_PRO_MODEL ?? "deepseek-reasoner";
const STAGE = process.argv[2] ?? "full";

if (!WEREAD_KEY) {
  console.error("ERROR: WEREAD_API_KEY not set. Add it to .env");
  process.exit(1);
}
if (!DEEPSEEK_KEY) {
  console.error("ERROR: DEEPSEEK_API_KEY not set. Add it to .env");
  process.exit(1);
}

const deepseek = { apiKey: DEEPSEEK_KEY, flashModel: FLASH_MODEL, proModel: PRO_MODEL };

console.log(`\n=== WeRead Personality Test (stage: ${STAGE}) ===`);
console.log(`Flash model: ${FLASH_MODEL}`);
console.log(`Pro   model: ${PRO_MODEL}\n`);

// ---- Stage 0 only ----
async function testStage0() {
  console.log("[ Stage 0a ] Fetching shelf...");
  const shelf = await getShelf(WEREAD_KEY);
  const privateSet = buildPrivateBookSet(shelf);
  console.log(`  Books on shelf: ${shelf.books?.length ?? 0}, private: ${privateSet.size}`);

  console.log("[ Stage 0b ] Fetching notebooks...");
  const all = await getAllNotebooks(WEREAD_KEY);
  console.log(`  Total notebooks: ${all.length}`);

  const candidates = all
    .filter(nb => !privateSet.has(nb.bookId) && (nb.noteCount + nb.reviewCount) > 0)
    .sort((a, b) => (b.noteCount + b.reviewCount) - (a.noteCount + a.reviewCount));

  console.log(`  Eligible (non-private, has notes/thoughts): ${candidates.length}`);
  console.log("\n  Top 5 books by note count:");
  candidates.slice(0, 5).forEach((nb, i) => {
    console.log(`    ${i + 1}. ${nb.book.title} — bookmarks:${nb.noteCount} thoughts:${nb.reviewCount}`);
  });

  // fetch + compress the top 1 book as a sample
  const sample = candidates[0];
  if (!sample) {
    console.log("\n  No eligible books found — stopping.");
    return;
  }

  console.log(`\n[ Stage 0c ] Fetching content for: "${sample.book.title}"...`);
  const [bookmarks, thoughts] = await Promise.all([
    getBookmarks(WEREAD_KEY, sample.bookId).catch(() => null),
    getMyReviews(WEREAD_KEY, sample.bookId).catch(() => []),
  ]);
  console.log(`  Raw bookmarks: ${bookmarks?.updated?.length ?? 0}, thoughts: ${thoughts.length}`);

  console.log("[ Stage 0d ] Compressing...");
  const compressed = compressBook(sample.book.title, sample.book.author, bookmarks, thoughts);
  console.log(`  Compressed chars: ${compressed.text.length} / 3000 cap`);
  console.log(`  totalBookmarks: ${compressed.totalBookmarks}, totalThoughts: ${compressed.totalThoughts}`);
  console.log("\n  --- Compressed content preview (first 500 chars) ---");
  console.log(compressed.text.slice(0, 500));
  console.log("  ---\n");
}

// ---- Stage 1 only (runs stage 0 first, then one DeepSeek call) ----
async function testStage1() {
  await testStage0();

  // Re-fetch top book for the LLM call
  console.log("[ Stage 1 ] Running DeepSeek Flash summary on top book...");
  const shelf = await getShelf(WEREAD_KEY);
  const privateSet = buildPrivateBookSet(shelf);
  const all = await getAllNotebooks(WEREAD_KEY);
  const candidate = all
    .filter(nb => !privateSet.has(nb.bookId) && (nb.noteCount + nb.reviewCount) > 0)
    .sort((a, b) => (b.noteCount + b.reviewCount) - (a.noteCount + a.reviewCount))[0];

  if (!candidate) return;

  const [bookmarks, thoughts] = await Promise.all([
    getBookmarks(WEREAD_KEY, candidate.bookId).catch(() => null),
    getMyReviews(WEREAD_KEY, candidate.bookId).catch(() => []),
  ]);
  const compressed = compressBook(candidate.book.title, candidate.book.author, bookmarks, thoughts);

  const raw = await complete(
    deepseek,
    FLASH_MODEL,
    [
      { role: "system", content: STAGE1_SYSTEM },
      { role: "user", content: stage1User(compressed) },
    ],
    { temperature: 0.4, max_tokens: 800, response_format: "json" },
  );

  console.log("\n  --- Stage 1 JSON output ---");
  try {
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch {
    console.log(raw);
  }
  console.log("  ---\n");
}

// ---- Full pipeline ----
async function testFull() {
  let portraitBuf = "";
  const emit = (e: ProgressEvent) => {
    switch (e.type) {
      case "status":
        console.log(`[status] ${e.message}`);
        break;
      case "progress":
        process.stdout.write(`\r[progress] ${e.current}/${e.total} ${e.bookTitle ?? ""}   `);
        if (e.current === e.total) process.stdout.write("\n");
        break;
      case "meta":
        console.log(`[meta] books:${e.totalBooks} excluded:${e.privateExcluded} bookmarks:${e.totalBookmarks} thoughts:${e.totalThoughts} selected:${e.selectedCount}`);
        break;
      case "portrait_delta":
        process.stdout.write(e.text);
        portraitBuf += e.text;
        break;
      case "done":
        console.log("\n\n[done] Portrait generation complete.");
        console.log(`Total portrait length: ${portraitBuf.length} chars`);
        break;
      case "error":
        console.error(`\n[error] ${e.message}`);
        break;
    }
  };

  await run({
    wereadKey: WEREAD_KEY,
    tier: "lt20",
    deepseek,
    emit,
  });
}

// ---- Dispatch ----
const t0 = Date.now();
try {
  if (STAGE === "0") {
    await testStage0();
  } else if (STAGE === "1") {
    await testStage1();
  } else {
    await testFull();
  }
  console.log(`\nElapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.error("\nFATAL:", e);
  process.exit(1);
}
