/** Native queue deliveries are captured here; consumer tests dispatch production handlers explicitly. */
export async function prepareQueueInbox(db: D1Database): Promise<void> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS test_queue_deliveries (id TEXT PRIMARY KEY, queue_name TEXT NOT NULL, body_json TEXT NOT NULL)",
    )
    .run();
}

export async function captureQueueDelivery(
  batch: MessageBatch<unknown>,
  db: D1Database,
): Promise<void> {
  await prepareQueueInbox(db);
  await db.batch(
    batch.messages.map((message) =>
      db
        .prepare(
          "INSERT INTO test_queue_deliveries (id, queue_name, body_json) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
        )
        .bind(message.id, batch.queue, JSON.stringify(message.body)),
    ),
  );
}
