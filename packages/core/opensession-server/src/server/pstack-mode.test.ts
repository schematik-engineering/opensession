import { describe, expect, test } from "bun:test";
import { join } from "path";
import {
	enablesPstackMode,
	isPstackCommand,
	pstackCommandInput,
	PSTACK_MODE_NOTE,
} from "./pstack-mode";
import {
	expandSkillCommand,
	SHIPPED_SKILLS_DIR,
} from "./skill-paths";
import { searchSkills } from "./skills";

describe("pstack mode", () => {
	test("recognizes task-bearing opening prompts and explicit opt-outs", () => {
		expect(enablesPstackMode("/pstack fix the retry regression")).toBe(true);
		expect(enablesPstackMode("/skill:pstack review this diff")).toBe(true);
		expect(enablesPstackMode(" /PSTACK on ")).toBe(true);
		expect(enablesPstackMode("/pstack off")).toBe(false);
		expect(enablesPstackMode("explain pstack")).toBe(false);
	});

	test("parses only the exact slash command", () => {
		expect(isPstackCommand("/pstack")).toBe(true);
		expect(isPstackCommand("/pstacking")).toBe(false);
		expect(pstackCommandInput("/skill:pstack   inspect this")).toBe(
			"inspect this",
		);
	});

	test("ships a self-contained standing reminder", () => {
		expect(PSTACK_MODE_NOTE).toContain("Pstack mode is enabled");
		expect(PSTACK_MODE_NOTE).toContain("spawn_task");
		expect(PSTACK_MODE_NOTE).toContain("never grants additional access");
	});

	test("lists and expands the bundled skill with its task", () => {
		const listed = searchSkills(process.cwd(), "pstack");
		expect(listed.some((skill) => skill.name === "pstack")).toBe(true);

		const dir = join(SHIPPED_SKILLS_DIR, "pstack");
		const expanded = expandSkillCommand("/pstack fix it", [
			{
				name: "pstack",
				filePath: join(dir, "SKILL.md"),
				baseDir: dir,
			},
		]);
		expect(expanded).toContain('<skill name="pstack"');
		expect(expanded).toContain("# Pstack mode");
		expect(expanded).toEndWith("fix it");
	});
});
