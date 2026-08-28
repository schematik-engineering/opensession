import { expect, test } from "bun:test";

const viewer = await Bun.file(new URL("../SessionViewer.tsx", import.meta.url)).text();

test("optimistic prompts keep their sender instead of borrowing the session owner", () => {
	const projection = viewer.match(
		/const optimisticTranscriptEntries:[\s\S]*?const pendingTranscriptDeliveryIds/,
	)?.[0];

	expect(projection).toContain("sender: pending.user");
});
