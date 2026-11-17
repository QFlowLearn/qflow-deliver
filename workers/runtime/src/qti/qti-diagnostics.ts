export function formatQtiDiagnostics(diagnostics: readonly { readonly message: string }[]): string {
  const messages = diagnostics
    .map((diagnostic) => diagnostic.message.trim())
    .filter((message) => message.length > 0);
  return messages.length > 0 ? messages.join("; ") : "unknown qti3 diagnostic";
}
