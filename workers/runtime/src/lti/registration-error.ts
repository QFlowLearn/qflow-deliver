export class LtiRegistrationError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LtiRegistrationError";
  }
}
