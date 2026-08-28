const COMPLETE_BOLD_HEADING = /^\s*\*\*([^*\n][^\n]*?)\*\*\s*$/;
const LEADING_BOLD_HEADING = /^\s*\*\*([^*\n][^\n]*?)\*\*(?:\r?\n+|\s*$)/;

/** Older Pi transcript rows predate `isReasoning`. A single bold-only message
 * before later model output/tool work is the provider's reasoning-summary
 * heading shape, not answer prose. */
export function isLegacyReasoningHeading(content: string): boolean {
	return COMPLETE_BOLD_HEADING.test(content);
}

/** Codex Desktop treats a leading `**…**` as summary chrome, not markdown in
 * the reasoning body. Split it out so the title stays regular-weight while any
 * real summary prose keeps its markdown structure. */
export function reasoningDisplay(content: string): {
	title: string;
	body: string;
} {
	const match = content.match(LEADING_BOLD_HEADING);
	if (!match) return { title: "", body: content.trim() };
	return {
		title: match[1]!.trim(),
		body: content.slice(match[0].length).trim(),
	};
}

/** During a streamed heading, the closing `**` may not have arrived yet. This
 * powers the live shimmer without ever handing markdown's bold marker to the
 * renderer. Multiline content is a normal model response instead. */
export function liveReasoningHeading(content: string): string | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith("**") || trimmed.includes("\n")) return null;
	const heading = trimmed.slice(2).replace(/\*\*\s*$/, "").trim();
	return heading || null;
}
