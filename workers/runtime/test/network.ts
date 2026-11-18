import { setupNetwork } from "@msw/cloudflare";
import { http, HttpResponse } from "msw/http";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";

export const network = setupNetwork();
const unexpectedRequests: string[] = [];

beforeAll(() => network.enable());
beforeEach(() => {
  network.use(
    http.all("*", ({ request }) => {
      unexpectedRequests.push(`${request.method} ${request.url}`);
      return HttpResponse.error();
    }),
  );
});
afterEach(() => {
  network.resetHandlers();
  const unexpected = unexpectedRequests.splice(0);
  expect(unexpected, "All outgoing HTTP requests must have an explicit handler").toEqual([]);
});
afterAll(() => network.disable());

/** Resolve browser-relative request URLs, then use the runtime's actual HTTP transport. */
export const fetchFromTestOrigin: typeof fetch = (input, init) =>
  fetch(typeof input === "string" ? new URL(input, "https://harbor.local") : input, init);
