import { describe, expect, test } from "bun:test";
import {
	isLegacyReasoningHeading,
	liveReasoningHeading,
	reasoningDisplay,
} from "./reasoning-display";

describe("reasoning display", () => {
	test("moves a generated bold heading out of markdown", () => {
		expect(
			reasoningDisplay(
				"**Checking deployment status**\n\nThe release is still moving.",
			),
		).toEqual({
			title: "Checking deployment status",
			body: "The release is still moving.",
		});
	});

	test("recognizes old heading-only reasoning rows", () => {
		expect(isLegacyReasoningHeading("**Checking deployment status**")).toBe(true);
		expect(isLegacyReasoningHeading("**Done**\n\nFinal answer")).toBe(false);
	});

	test("extracts a partial streamed heading for the shimmer", () => {
		expect(liveReasoningHeading("**Checking deploy")).toBe("Checking deploy");
		expect(liveReasoningHeading("**Checking deploy**")).toBe("Checking deploy");
		expect(liveReasoningHeading("**Title**\n\nBody")).toBeNull();
	});
});
