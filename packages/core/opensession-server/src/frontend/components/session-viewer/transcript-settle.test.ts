import { expect, test } from "bun:test";
import { readFollowingLive } from "./transcript-anchor";

const viewer = await Bun.file(new URL("../SessionViewer.tsx", import.meta.url)).text();
const settledCallback = viewer.match(
	/const onVisibleRangesSettled = useCallback\([\s\S]*?\}, \[followingLive, scrollToLatest, transcriptIndex, transcriptOutlineReady\]\);/,
)?.[0];

test("fresh transcript ranges reaffirm a cached reader's live edge", () => {
	expect(settledCallback).toContain("settledIndexRef.current = transcriptIndex");
	expect(settledCallback).toContain(
		'if (readFollowingLive(followingLive)) scrollToLatest("auto")',
	);
});

test("setup and loading surfaces leave before transcript rows mount", () => {
	expect(viewer).toContain('<AnimatePresence initial={false} mode="wait">');
	expect(viewer).not.toContain('<AnimatePresence initial={false} mode="popLayout">');
});

test("indexed transcripts settle positively but cannot stay hidden forever", () => {
	expect(settledCallback).toContain("if (!transcriptOutlineReady) return");
	expect(settledCallback).toContain("setOpenSettlePending(false)");
	expect(viewer).toContain("setTranscriptOutlineReady(!v2)");
	expect(viewer).toContain("setTranscriptOutlineReady(true)");
	expect(viewer).toContain("const LEGACY_OPEN_SETTLE_MAX_MS = 350");
	expect(viewer).toContain("const INDEXED_OPEN_SETTLE_MAX_MS = 2_500");
	expect(viewer).toContain("if (!transcriptRendered) return");
	expect(viewer).toContain("? INDEXED_OPEN_SETTLE_MAX_MS");
	expect(viewer).toContain(": LEGACY_OPEN_SETTLE_MAX_MS,");
	expect(viewer).toContain(
		'"w-full shrink-0 motion-safe:transition-opacity motion-safe:duration-150"',
	);
});

test("late action clearance keeps a following transcript at the bottom", () => {
	const clearanceEffect = viewer.match(
		/useLayoutEffect\(\(\) => \{\s*if \(readFollowingLive\(followingLive\)\) scrollToLatest\("auto"\);\s*\}, \[actionClearance, followingLive, scrollToLatest\]\);/,
	)?.[0];

	expect(clearanceEffect).toBeDefined();
	expect(viewer).toContain("actionClearance,");
});

test("a sent prompt scrolls again after its optimistic row commits", () => {
	expect(viewer).toContain("sentPromptNeedsLayoutScrollRef.current = true");
	const contentLayoutEffect = viewer.match(
		/\/\/ After any content change:[\s\S]*?\}, \[\s*entries,[\s\S]*?scrollToLatest,[\s\S]*?\]\);/,
	)?.[0];

	expect(contentLayoutEffect).toContain("relayout()");
	expect(contentLayoutEffect).toContain(
		"if (!sentPromptNeedsLayoutScrollRef.current) return",
	);
	expect(contentLayoutEffect).toContain('scrollToLatest("auto")');
});

test("the stable callback reads current live-edge intent when it runs", () => {
	const following = { current: true };
	expect(readFollowingLive(following)).toBe(true);
	following.current = false;
	expect(readFollowingLive(following)).toBe(false);
});
