import { describe, expect, test } from "bun:test";
import { selectedSkillCommand } from "./skill-command";

describe("selectedSkillCommand", () => {
	test("marks a picker selection as an explicit skill invocation", () => {
		expect(selectedSkillCommand("pstack")).toBe("/skill:pstack");
		expect(selectedSkillCommand("better-ui")).toBe("/skill:better-ui");
	});
});
