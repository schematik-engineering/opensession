export interface ComposerBinding {
  setTyping: (sessionId: string, active: boolean) => void;
  /** Bumped to clear the draft and return the session to the live edge. */
  resetSeq?: number;
  /** Focus the composer when the session opens. Ignored on phones. */
  autoFocus?: boolean;
  /** One-shot draft text appended from another surface, such as Checks. */
  prefill?: { seq: number; text: string } | null;
  onPrefillConsumed?: (seq: number) => void;
}
