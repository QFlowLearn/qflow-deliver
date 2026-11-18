type BeforeQueueSend<Body> = (message: Body, options?: QueueSendOptions) => Promise<void> | void;

/** Observe or pause a real local queue operation; successful sends always reach the binding. */
export function observeQueue<Body>(
  queue: Queue<Body> | undefined,
  input?: {
    beforeSend?: BeforeQueueSend<Body>;
    sendBatchError?: string;
  },
): Queue<Body> {
  if (!queue) throw new Error("A local queue binding is required");
  return {
    metrics: queue.metrics.bind(queue),
    async send(message, options) {
      await input?.beforeSend?.(message, options);
      return queue.send(message, options);
    },
    async sendBatch(messages) {
      if (input?.sendBatchError) throw new Error(input.sendBatchError);
      return queue.sendBatch(messages);
    },
  };
}
