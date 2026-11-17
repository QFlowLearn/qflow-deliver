import {
  analyzeQtiDeliverySecurity,
  buildQtiDeliverySafeXml,
  prepareQtiDeliveryXml,
  type QtiValue,
} from "@longsightgroup/qti3-core";
import { formatQtiDiagnostics } from "./qti-diagnostics";

interface QtiDeliveryResult {
  readonly ok: boolean;
  readonly diagnostics: readonly { readonly message: string }[];
}

export function buildDeliverySafeItemXml(xml: string): string {
  return unwrapDeliveryResult(
    buildQtiDeliverySafeXml(xml),
    (result) => result.xml,
    "Item XML cannot be prepared for secure delivery",
  );
}

export function buildInitialAdaptiveDeliveryXml(itemXml: string): string {
  return unwrapDeliveryResult(
    prepareQtiDeliveryXml(itemXml, {
      mode: "server-materialized-adaptive",
      outcomes: {},
    }),
    (result) => result.candidateSafeXml,
    "Initial adaptive item XML cannot be prepared for secure delivery",
  );
}

export function buildAdaptiveCandidateDeliveryXml(input: {
  itemXml: string;
  outcomes: Record<string, QtiValue>;
  templateValues?: Record<string, QtiValue>;
}): string {
  return unwrapDeliveryResult(
    prepareQtiDeliveryXml(input.itemXml, {
      mode: "server-materialized-adaptive",
      outcomes: input.outcomes,
      ...(input.templateValues === undefined ? {} : { templateValues: input.templateValues }),
    }),
    (result) => result.candidateSafeXml,
    "Adaptive item XML cannot be prepared for secure delivery",
  );
}

export function assertDeliverySafeItemXml(xml: string): void {
  const analysis = analyzeQtiDeliverySecurity(xml);
  if (analysis.deliverySafe) {
    return;
  }

  throwQtiDeliveryError(
    "Delivery item XML still contains forbidden QTI delivery content",
    analysis.diagnostics,
  );
}

export function assertStaticSecureDeliverySupported(input: {
  itemIdentifier: string;
  itemXml: string;
  adaptive: boolean;
}): void {
  assertDeliveryResult(
    prepareQtiDeliveryXml(input.itemXml, { mode: "static" }),
    `Item ${input.itemIdentifier} is not supported for secure delivery`,
  );
}

export function assertInitialAdaptiveDeliverySupported(input: {
  itemIdentifier: string;
  itemXml: string;
}): void {
  assertDeliveryResult(
    prepareQtiDeliveryXml(input.itemXml, {
      mode: "server-materialized-adaptive",
      outcomes: {},
    }),
    `Item ${input.itemIdentifier} is not supported for initial adaptive delivery`,
  );
}

function unwrapDeliveryResult<TResult, TDeliveryResult extends QtiDeliveryResult>(
  result: TDeliveryResult,
  select: (result: TDeliveryResult) => TResult | undefined,
  failureMessage: string,
): TResult {
  const value = select(result);
  if (result.ok && value !== undefined) {
    return value;
  }

  throwQtiDeliveryError(failureMessage, result.diagnostics);
}

function assertDeliveryResult(result: QtiDeliveryResult, failureMessage: string): void {
  if (result.ok) {
    return;
  }

  throwQtiDeliveryError(failureMessage, result.diagnostics);
}

function throwQtiDeliveryError(
  failureMessage: string,
  diagnostics: readonly { readonly message: string }[],
): never {
  throw new Error(`${failureMessage}: ${formatQtiDiagnostics(diagnostics)}`);
}
