/** Reports unexpected UI task failures through the host's uncaught-error channel.
 * Expected failures belong in the owning feature's error state.
 */
export function reportUiError(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}
