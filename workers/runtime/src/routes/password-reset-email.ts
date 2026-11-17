import { EmailMessage } from "cloudflare:email";

const RESET_EMAIL_SUBJECT = "Reset your QFlowLearn Delivery password";

export function buildResetEmailMessage(input: {
  from: string;
  to: string;
  text: string;
}): EmailMessage {
  const from = readSafeEmailAddress(input.from, "from");
  const to = readSafeEmailAddress(input.to, "to");
  const raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${RESET_EMAIL_SUBJECT}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text,
  ].join("\r\n");
  return new EmailMessage(from, to, raw);
}

export function buildResetUrl(input: { origin: string; token: string }): string {
  const resetUrl = new URL("/reset-password", input.origin);
  resetUrl.searchParams.set("token", input.token);
  return resetUrl.toString();
}

export function buildResetEmailText(input: {
  displayName: string;
  resetUrl: string;
  expiresAt: string;
}): string {
  return [
    `Hi ${input.displayName},`,
    "",
    "Use this link to reset your QFlowLearn Delivery password:",
    input.resetUrl,
    "",
    `This link expires at ${input.expiresAt}.`,
    "",
    "If you did not request a password reset, you can ignore this email.",
  ].join("\n");
}

function readSafeEmailAddress(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) {
    throw new Error(`${label} email address is invalid`);
  }
  return trimmed;
}
