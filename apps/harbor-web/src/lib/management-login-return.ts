/** Only the supported management destination may override the normal login landing page. */
export function managementLoginReturn(url: URL): string {
  if (url.searchParams.get("returnTo") !== "assessments") return "/";
  const params = new URLSearchParams();
  const versionId = url.searchParams.get("assessmentVersionId");
  if (versionId) params.set("assessmentVersionId", versionId);
  const query = params.toString();
  return `/assessments${query ? `?${query}` : ""}`;
}
