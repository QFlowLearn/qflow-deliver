import type { AttemptItemQtiSnapshot } from "@harbor/attempt-protocol";
import {
  parseQtiXml,
  validateQtiResponseVariables,
  type QtiAssessmentItem,
  type QtiDiagnostic,
  type QtiResponseValidationDiagnostic as UpstreamQtiResponseValidationDiagnostic,
} from "@longsightgroup/qti3-core";
import { SERVER_ITEM_RESPONSE_VARIABLES } from "../qti/server-item-response-variables";

export type QtiResponseValidationCode =
  | "qti.response.item.parse"
  | "qti.response.required.missing"
  | "qti.response.cardinality.invalid"
  | "qti.response.minChoices"
  | "qti.response.maxChoices"
  | "qti.response.minAssociations"
  | "qti.response.maxAssociations"
  | "qti.response.matchMax"
  | "qti.response.identifier.required"
  | "qti.response.identifier.undeclared"
  | "qti.response.value.invalid";

export interface QtiResponseValidationDiagnostic {
  code: QtiResponseValidationCode;
  itemId: string;
  identifier: string | null;
  message: string;
}

export interface QtiResponseValidationResult {
  ok: boolean;
  diagnostics: QtiResponseValidationDiagnostic[];
}

export function validateSubmittedQtiResponses(input: {
  itemId: string;
  itemXml: string;
  itemSnapshot: Pick<AttemptItemQtiSnapshot, "responseVariables"> | undefined;
  allowIncompleteResponses: boolean;
}): QtiResponseValidationResult {
  const parsed = parseQtiXml(input.itemXml);
  if (!parsed.ok || !parsed.document) {
    return {
      ok: false,
      diagnostics: buildParseDiagnostics(input.itemId, parsed.diagnostics),
    };
  }

  return validateParsedQtiResponses({
    itemId: input.itemId,
    item: parsed.document.item,
    itemSnapshot: input.itemSnapshot,
    allowIncompleteResponses: input.allowIncompleteResponses,
  });
}

export function validateParsedQtiResponses(input: {
  itemId: string;
  item: QtiAssessmentItem;
  itemSnapshot: Pick<AttemptItemQtiSnapshot, "responseVariables"> | undefined;
  allowIncompleteResponses: boolean;
}): QtiResponseValidationResult {
  const responseVariables = input.itemSnapshot?.responseVariables ?? [];
  const result = validateQtiResponseVariables({
    item: input.item,
    responses: responseVariables,
    allowIncompleteResponses: input.allowIncompleteResponses,
    requireScoredResponses: true,
    allowedUndeclaredResponseIdentifiers: [...SERVER_ITEM_RESPONSE_VARIABLES],
  });
  const diagnostics = result.diagnostics.map((diagnostic) =>
    toHarborDiagnostic(input.itemId, input.item, diagnostic),
  );

  return {
    ok: result.ok,
    diagnostics,
  };
}

function buildParseDiagnostics(
  itemId: string,
  parseDiagnostics: readonly QtiDiagnostic[],
): QtiResponseValidationDiagnostic[] {
  const errorDiagnostics = parseDiagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const diagnostics = errorDiagnostics.length > 0 ? errorDiagnostics : parseDiagnostics;
  if (diagnostics.length === 0) {
    return [
      {
        code: "qti.response.item.parse",
        itemId,
        identifier: null,
        message: "Authoritative QTI XML could not be parsed before response validation.",
      },
    ];
  }
  return diagnostics.map((diagnostic) => ({
    code: "qti.response.item.parse",
    itemId,
    identifier: null,
    message: `Authoritative QTI XML could not be parsed before response validation: ${diagnostic.message}`,
  }));
}

export function formatQtiResponseValidationDiagnostics(
  diagnostics: readonly QtiResponseValidationDiagnostic[],
): string {
  return diagnostics
    .map((diagnostic) =>
      [
        diagnostic.code,
        diagnostic.itemId,
        diagnostic.identifier ?? "(item)",
        diagnostic.message,
      ].join(": "),
    )
    .join("; ");
}

function toHarborDiagnostic(
  itemId: string,
  item: QtiAssessmentItem,
  diagnostic: UpstreamQtiResponseValidationDiagnostic,
): QtiResponseValidationDiagnostic {
  const identifier = diagnostic.identifier?.trim() || diagnostic.path?.trim() || null;
  return {
    code: toHarborDiagnosticCode(item, identifier, diagnostic.code),
    itemId,
    identifier,
    message: diagnostic.message,
  };
}

function toHarborDiagnosticCode(
  item: QtiAssessmentItem,
  identifier: string | null,
  code: UpstreamQtiResponseValidationDiagnostic["code"],
): QtiResponseValidationCode {
  if (code === "response.required") {
    return minimumDiagnosticCode(item, identifier);
  }
  if (code === "response.maximum") {
    return maximumDiagnosticCode(item, identifier);
  }
  if (code === "response.matchMax") {
    return "qti.response.matchMax";
  }
  if (code === "response.cardinality") {
    return "qti.response.cardinality.invalid";
  }
  if (code === "response.undeclared") {
    return "qti.response.identifier.undeclared";
  }
  if (code === "response.identifier.required") {
    return "qti.response.identifier.required";
  }
  return "qti.response.value.invalid";
}

function minimumDiagnosticCode(
  item: QtiAssessmentItem,
  identifier: string | null,
): QtiResponseValidationCode {
  const interaction = firstInteractionForResponse(item, identifier);
  if (interaction?.attributes["min-associations"] !== undefined) {
    return "qti.response.minAssociations";
  }
  if (interaction?.attributes["min-choices"] !== undefined) {
    return "qti.response.minChoices";
  }
  return "qti.response.required.missing";
}

function maximumDiagnosticCode(
  item: QtiAssessmentItem,
  identifier: string | null,
): QtiResponseValidationCode {
  const interaction = firstInteractionForResponse(item, identifier);
  if (interaction?.attributes["max-associations"] !== undefined) {
    return "qti.response.maxAssociations";
  }
  return "qti.response.maxChoices";
}

function firstInteractionForResponse(item: QtiAssessmentItem, identifier: string | null) {
  if (!identifier) {
    return undefined;
  }

  return item.interactions.find((interaction) => interaction.responseIdentifier === identifier);
}
