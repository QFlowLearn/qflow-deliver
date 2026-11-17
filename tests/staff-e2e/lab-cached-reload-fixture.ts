import { expect, type Page } from "@playwright/test";

export const acceptedEssay = "Accepted before the cached reload.";
export const pendingEssay = "The newer journaled answer must survive reconnect during startup.";
export const eventsUrl = "**/api/attempts/*/events";

export async function preparePendingAnswer(page: Page) {
  await page
    .getByRole("textbox", { name: "Explain your reasoning.", exact: true })
    .fill(acceptedEssay);
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await page.route(eventsUrl, (route) => route.abort("failed"));
  await page
    .getByRole("textbox", { name: "Explain your reasoning.", exact: true })
    .fill(pendingEssay);
  await expect(page.getByTestId("pending-event-count")).toHaveText("1");
  await expect(page.getByTestId("response-save-status")).toHaveText(
    "Saved locally; server confirmation pending",
  );
}

export async function expectRecovered(page: Page) {
  await expect(page.getByTestId("pending-event-count")).toHaveText("0");
  await expect(
    page.getByRole("textbox", { name: "Explain your reasoning.", exact: true }),
  ).toHaveValue(pendingEssay);
  await expect(page.getByTestId("response-save-status")).toContainText("Server confirmed");
  await expect(page.getByTestId("save-response-button")).toBeEnabled();
  await expect(page.getByTestId("submission-state")).toHaveText("none");
  await expect(page.getByRole("alert").filter({ hasText: "Failed to fetch" })).toHaveCount(0);
}

export function deferred<T>() {
  let resolve!: (value: T) => void; // SAFETY: the Promise executor initializes this synchronously.
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/** Inspect durable acknowledgements, never the credentials or response payloads in browser storage. */
export async function readReceipts(page: Page): Promise<unknown[]> {
  const attemptId = await page.getByTestId("attempt-id").innerText();
  return page.evaluate(
    (attemptId) =>
      new Promise<unknown[]>((resolve, reject) => {
        const opened = indexedDB.open("harbor-attempt-recovery");
        opened.onerror = () => reject(opened.error);
        opened.onsuccess = () => {
          const db = opened.result;
          const transaction = db.transaction("replay-receipts", "readonly");
          const request = transaction
            .objectStore("replay-receipts")
            .index("attemptId")
            .getAll(attemptId);
          transaction.oncomplete = () => db.close();
          transaction.onabort = () => {
            db.close();
            reject(transaction.error);
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const records: unknown = request.result;
            if (!Array.isArray(records)) {
              reject(new Error("Invalid durable receipts"));
              return;
            }
            resolve(records);
          };
        };
      }),
    attemptId,
  );
}

export async function expectAcceptedCheckpoint(page: Page, expectedEssay = pendingEssay) {
  const credentials = await page.evaluate(() => {
    const cached: unknown = JSON.parse(
      sessionStorage.getItem("harbor.bootstrappedSession") ?? "null",
    );
    if (
      !cached ||
      typeof cached !== "object" ||
      !("session" in cached) ||
      !cached.session ||
      typeof cached.session !== "object" ||
      !("envelope" in cached.session) ||
      !cached.session.envelope ||
      typeof cached.session.envelope !== "object" ||
      !("bootstrapToken" in cached.session.envelope) ||
      typeof cached.session.envelope.bootstrapToken !== "string"
    )
      throw new Error("Missing cached bootstrap credential");
    const clientSessionId = sessionStorage.getItem("harbor.clientSessionId");
    if (!clientSessionId) throw new Error("Missing current client identity");
    return { bootstrapToken: cached.session.envelope.bootstrapToken, clientSessionId };
  });
  const fresh = await page.request.post("/api/bootstrap", { data: credentials });
  expect(fresh.status()).toBe(200);
  const accepted: unknown = await fresh.json();
  if (
    !accepted ||
    typeof accepted !== "object" ||
    !("session" in accepted) ||
    !accepted.session ||
    typeof accepted.session !== "object" ||
    !("responseCheckpoint" in accepted.session)
  )
    throw new Error("Missing accepted response checkpoint");
  expect(accepted.session.responseCheckpoint).toMatchObject({
    items: {
      "item-1": { responses: { ESSAY: expectedEssay } },
    },
  });
}
