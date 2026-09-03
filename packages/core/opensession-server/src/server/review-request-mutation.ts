interface ReviewRequestMutation {
  sessionId: string;
  persist: () => void | Promise<void>;
  mirrorToProvider?: () => void | Promise<void>;
  onMirrorError?: (error: unknown) => void;
}

const providerMirrorQueues = new Map<string, Promise<void>>();

/**
 * Save Open Session's review request before starting the provider mirror.
 *
 * The local request drives the reviewer's inbox and notification. Mirroring it
 * onto a pull request is useful, but a slow or rejected provider call must not
 * undo the assignment the person just made in Open Session. Provider writes
 * for one session stay ordered so a quick reassignment cannot finish backward.
 */
export async function persistReviewRequest({
  sessionId,
  persist,
  mirrorToProvider,
  onMirrorError,
}: ReviewRequestMutation): Promise<void> {
  await persist();
  if (!mirrorToProvider) return;

  const previous = providerMirrorQueues.get(sessionId) ?? Promise.resolve();
  const queued = previous.then(mirrorToProvider).catch((error: unknown) => {
    try {
      onMirrorError?.(error);
    } catch {
      // A diagnostic failure must not break this best-effort queue.
    }
  });
  providerMirrorQueues.set(sessionId, queued);
  void queued.then(() => {
    if (providerMirrorQueues.get(sessionId) === queued)
      providerMirrorQueues.delete(sessionId);
  });
}
