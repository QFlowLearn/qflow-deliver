import { runDurableObjectAlarm } from "cloudflare:test";

/** Move the injected delivery clock to the real alarm's due time, then run that alarm. */
export async function runOutboxAlarm(stub: DurableObjectStub): Promise<boolean> {
  const advanced = await stub.fetch("https://harbor-attempt.local/__test/outbox/advance-outbox");
  if (advanced.status === 404) return false;
  if (advanced.status !== 204) throw new Error("Test delivery clock was not advanced");
  return runDurableObjectAlarm(stub);
}
