import { describe, expect, test } from "bun:test";
import { busyActivityStatus } from "./busy-activity";

describe("busyActivityStatus", () => {
	test("starts with a quiet working label", () => {
		expect(busyActivityStatus(9_999)).toEqual({
			label: "Working",
			elapsed: null,
		});
	});

	test("acknowledges a visible pause after ten seconds", () => {
		expect(busyActivityStatus(12_000)).toEqual({
			label: "Still working",
			elapsed: "12s",
		});
	});

	test("sets expectations for an extended run", () => {
		expect(busyActivityStatus(45_000)).toEqual({
			label: "Taking longer than usual",
			elapsed: "45s",
		});
		expect(busyActivityStatus(90_000)).toEqual({
			label: "Taking longer than usual",
			elapsed: "1m",
		});
	});

	test("clamps clock skew", () => {
		expect(busyActivityStatus(-1)).toEqual({
			label: "Working",
			elapsed: null,
		});
	});
});
