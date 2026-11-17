type QueueMockSend<Body> = (message: Body, options?: QueueSendOptions) => Promise<void> | void;

export function createQueueMock<Body>(input?: {
  send?: QueueMockSend<Body>;
  sendBatchError?: string;
  metrics?: QueueMetrics;
}): Queue<Body> {
  return {
    async metrics() {
      return copyQueueMetrics(input?.metrics);
    },
    async send(message, options) {
      await input?.send?.(message, options);
      return {
        metadata: {
          metrics: copyQueueMetrics(input?.metrics),
        },
      };
    },
    async sendBatch() {
      throw new Error(input?.sendBatchError ?? "sendBatch is not used in this test");
    },
  };
}

function copyQueueMetrics(metrics?: QueueMetrics): QueueMetrics {
  return {
    backlogCount: metrics?.backlogCount ?? 0,
    backlogBytes: metrics?.backlogBytes ?? 0,
    oldestMessageTimestamp: metrics?.oldestMessageTimestamp,
  };
}
