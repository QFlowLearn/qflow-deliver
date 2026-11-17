import type { TransferWorkstationPolicyCommand } from "@harbor/attempt-protocol";
import type { StoredAttemptState } from "./attempt-state-bootstrap";
import { STATE_KEY } from "./attempt-state-bootstrap";
import { AttemptDurableObjectRequestError } from "./attempt-request-error";
import { resolveAttemptStatus } from "./attempt-status";

/** A supervised transfer changes only write ownership; a replay cannot reclaim a superseded session. */
export async function transferWorkstation(
  storage: DurableObjectStorage,
  state: StoredAttemptState,
  command: TransferWorkstationPolicyCommand,
): Promise<StoredAttemptState> {
  if (resolveAttemptStatus(state) === "submitted")
    throw new AttemptDurableObjectRequestError(
      409,
      "Submitted attempts cannot transfer workstations",
    );
  const key = `workstation-transfer:${command.commandId}`;
  const previous = await storage.get<unknown>(key);
  if (previous) {
    if (
      JSON.stringify(previous) !== JSON.stringify(command) ||
      state.currentClientSessionId !== command.clientSessionId
    )
      throw new AttemptDurableObjectRequestError(409, "Transfer command was changed or superseded");
    return state;
  }
  const next = { ...state, currentClientSessionId: command.clientSessionId };
  await storage.put({ [STATE_KEY]: next, [key]: command });
  return next;
}
