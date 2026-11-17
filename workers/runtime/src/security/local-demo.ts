/** Recognize loopback and Harbor's exact in-process test origin for explicitly enabled demos. */
export function isLocalDemoUrl(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "harbor.local"
  );
}
