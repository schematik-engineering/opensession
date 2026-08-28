import { expect, test } from "bun:test";

const summarySource = await Bun.file(
	new URL("./WorkspaceSummary.tsx", import.meta.url),
).text();
const infoSource = await Bun.file(
	new URL("./WorkspaceInfo.tsx", import.meta.url),
).text();
const apiSource = await Bun.file(
	new URL("../lib/api/workspaces.ts", import.meta.url),
).text();

test("workspace surfaces keep committed and uncommitted work separate", () => {
	expect(apiSource).toContain("commits?: WorkspaceCommit[]");
	expect(summarySource).toContain(
		"(diffIsCommitted || commits.length > 0)",
	);
	expect(summarySource).toContain(">Committed</div>");
	expect(summarySource).toContain(">Uncommitted</div>");
	expect(summarySource).toContain("commits.map(committedRow)");
	expect(infoSource).toContain("commits.map((commit)");
	expect(infoSource).toContain("<CommitRow key={commit.sha} commit={commit} />");
});

test("folded commits open in a nested overlay", () => {
	expect(summarySource).toContain("<Popover.Root exclusive={false}>");
	expect(summarySource).toContain('side={embedded ? "bottom" : "left"}');
	expect(summarySource).toContain("commits.map(committedRow)");
	expect(summarySource).not.toContain("setCommitsOpen");
});

test("uncommitted work opens Changes without using the separate commit action", () => {
	expect(summarySource).toContain("function openUncommittedChanges()");
	expect(summarySource).toContain('onOpenPanelTab("changes")');
	expect(summarySource).toContain("onClick={openUncommittedChanges}");
	expect(summarySource).toContain("onClick={askCommit}");
	expect(summarySource).toContain('title="View uncommitted changes"');
});

test("an assigned reviewer can be changed or cleared from the summary", () => {
	expect(summarySource).toContain("reviewRequestSessionId?: string");
	expect(summarySource).toContain("Clear review request");
	expect(summarySource).toContain(
		"const owner = (previous && reviewRequestSessionId) || session.id",
	);
	expect(summarySource).toContain("onReviewChange?.(owner, next)");
	expect(summarySource).toContain("onReviewChange?.(owner, previous)");
});

test("popup review heading keeps a small gap after a lone PR band", () => {
	expect(summarySource).toContain('"[&>.ws-summary-band:last-child]:mb-0"');
	expect(summarySource).toContain(
		'"[.ws-summary-pr-group:has(>.ws-summary-band:last-child)+.ws-summary-review-group_&]:mt-1"',
	);
});
