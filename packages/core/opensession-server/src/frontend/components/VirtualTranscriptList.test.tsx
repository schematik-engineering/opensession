import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	committedTranscriptMeasureKeys,
	didScrollTranscriptTowardHistory,
	VirtualTranscriptList,
	shouldAdjustTranscriptScroll,
	shouldTransitionTranscriptItemPosition,
	type VirtualTranscriptItem,
	virtualTranscriptRange,
} from "./VirtualTranscriptList";

function item(index: number): VirtualTranscriptItem {
	return {
		key: `block-${index}`,
		anchorId: `entry-${index}`,
		entryIds: [`entry-${index}`],
		estimateSize: 80,
		content: <span>Block {index}</span>,
	};
}

const source = await Bun.file(
	new URL("./VirtualTranscriptList.tsx", import.meta.url),
).text();

describe("VirtualTranscriptList", () => {
	test("defers observer fallback while keeping semantic measurement pre-paint", () => {
		expect(source).toContain("useAnimationFrameWithResizeObserver: true");
		expect(source).toContain("this.measureCommittedRows(prevProps)");
	});

	test("captures history intent before scroll-driven rerenders", () => {
		expect(source).toContain("capture: true");
		expect(source).toContain('removeEventListener(\n\t\t\t"scroll"');
	});
	test("keeps the live-edge tail in the same virtual coordinate space", () => {
		expect(virtualTranscriptRange([10, 11], 40, 3)).toEqual([10, 11, 37, 38, 39]);
		expect(virtualTranscriptRange([0, 1], 2, 24)).toEqual([0, 1]);
	});

	test("treats every upward scroll path as history intent", () => {
		expect(didScrollTranscriptTowardHistory(1_000, 700)).toBe(true);
		expect(didScrollTranscriptTowardHistory(700, 700)).toBe(false);
		expect(didScrollTranscriptTowardHistory(700, 1_000)).toBe(false);
		expect(didScrollTranscriptTowardHistory(700, 699.75)).toBe(false);
		// A child can sample zero before its parent restores the live edge. A
		// one-step scrollbar/Home jump back to zero must still request history.
		expect(didScrollTranscriptTowardHistory(0, 0, 745, 6_226)).toBe(true);
		expect(didScrollTranscriptTowardHistory(0, 500, 745, 6_226)).toBe(false);
		expect(didScrollTranscriptTowardHistory(0, 0, 745, 900)).toBe(false);
	});

	test("keeps the viewport stable when measured rows above it resize", () => {
		expect(shouldAdjustTranscriptScroll(400, 600)).toBe(true);
		expect(shouldAdjustTranscriptScroll(600, 600)).toBe(true);
		expect(shouldAdjustTranscriptScroll(700, 600)).toBe(false);
	});

	test("compensates a newly hydrated head row while it straddles the viewport", () => {
		expect(shouldAdjustTranscriptScroll(1_200, 600, true)).toBe(true);
	});

	test("keeps positive live-edge growth pinned in the measurement frame", () => {
		expect(shouldAdjustTranscriptScroll(1_200, 600, false, 140)).toBe(true);
		expect(shouldAdjustTranscriptScroll(1_200, 600, false, -140)).toBe(false);
	});

	test("keeps prompt reconciliation out of position transitions", () => {
		expect(shouldTransitionTranscriptItemPosition(item(0))).toBe(true);
		expect(
			shouldTransitionTranscriptItemPosition({
				...item(0),
				arrivalAliases: ["outbox-prompt"],
			}),
		).toBe(false);
	});

	test("synchronously remeasures new and extended semantic rows", () => {
		const before = [item(0), item(1)];
		const extended = { ...item(1), entryIds: ["entry-1", "tool-result-1"] };
		const added = item(2);
		expect(
			[...committedTranscriptMeasureKeys(before, [item(0), extended, added])],
		).toEqual(["block-1", "block-2"]);
		expect(
			[
				...committedTranscriptMeasureKeys(
					[{ ...item(0), measureVersion: ["entry-0:10"] }],
					[{ ...item(0), measureVersion: ["entry-0:20"] }],
				),
			],
		).toEqual(["block-0"]);
		expect(
			committedTranscriptMeasureKeys(before, [item(0), item(1)]).size,
		).toBe(0);
	});

	test("renders complete semantic content without browser measurement", () => {
		const html = renderToStaticMarkup(
			<VirtualTranscriptList
				items={[item(0), item(1), item(2)]}
				trailingMounted={1}
			/>,
		);
		expect(html).toContain("Block 0");
		expect(html).toContain("Block 2");
		expect(html).not.toContain("data-virtual-transcript");
	});
});
