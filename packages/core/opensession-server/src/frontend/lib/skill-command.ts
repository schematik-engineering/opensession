/**
 * Canonical wire text for a skill chosen from the composer menu.
 *
 * People may still type `/name` by hand, but a menu selection is explicit so
 * the runner can distinguish an intentional skill invocation from ordinary
 * slash-prefixed prose without relying on UI-only state.
 */
export function selectedSkillCommand(name: string): string {
	return `/skill:${name}`;
}
