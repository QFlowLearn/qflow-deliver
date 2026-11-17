export function downloadTextFile(input: {
  filename: string;
  content: string;
  contentType: string;
}): void {
  const blob = new Blob([input.content], { type: input.contentType });
  downloadBlobFile({ filename: input.filename, blob });
}

export function downloadBlobFile(input: { filename: string; blob: Blob }): void {
  const url = URL.createObjectURL(input.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = input.filename;
  link.click();
  URL.revokeObjectURL(url);
}
