export class AttemptDurableObjectRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export function isStatusError(error: unknown): error is AttemptDurableObjectRequestError & {
  status: number;
  message: string;
} {
  return error instanceof Error && "status" in error && typeof error.status === "number";
}
