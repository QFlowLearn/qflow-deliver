import {
  parseQtiTest,
  restoreQtiTestSession,
  snapshotQtiTestSession,
  type QtiExecutableTest,
  type QtiTestSession,
  type QtiTestSessionSnapshot,
} from "@longsightgroup/qti3-core";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";

/** One per Durable Object. Persisted snapshots remain authoritative; cold starts replay them. */
export class TestSessionRuntime {
  private cached: {
    objectKey: string;
    test: QtiExecutableTest;
    snapshotKey: string;
    session: QtiTestSession;
  } | null = null;
  constructor(private readonly bucket: R2Bucket) {}

  async restore(objectKey: string, snapshot: QtiTestSessionSnapshot) {
    const snapshotKey = JSON.stringify(snapshot);
    if (this.cached?.objectKey === objectKey && this.cached.snapshotKey === snapshotKey)
      return this.cached;
    let test = this.cached?.objectKey === objectKey ? this.cached.test : null;
    if (!test) test = await loadTestSessionDefinition(this.bucket, objectKey);
    const restored = restoreQtiTestSession(test, snapshot);
    if (!restored.ok)
      throw new AttemptDurableObjectRequestError(409, "Saved test route is invalid");
    this.cached = { objectKey, test, snapshotKey, session: restored.value };
    return this.cached;
  }

  remember(
    objectKey: string,
    test: QtiExecutableTest,
    session: QtiTestSession,
  ): QtiTestSessionSnapshot {
    const snapshot = snapshotQtiTestSession(session);
    // A failed storage commit leaves the previous snapshot, which cannot hit this entry.
    this.cached = { objectKey, test, snapshotKey: JSON.stringify(snapshot), session };
    return snapshot;
  }
}

export async function loadTestSessionDefinition(
  bucket: R2Bucket,
  objectKey: string,
): Promise<QtiExecutableTest> {
  const object = await bucket.get(objectKey);
  if (!object) throw new AttemptDurableObjectRequestError(500, "Published test is unavailable");
  const parsed = parseQtiTest(await object.text());
  if (!parsed.ok)
    throw new AttemptDurableObjectRequestError(409, "Published test cannot be executed");
  return parsed.value;
}
