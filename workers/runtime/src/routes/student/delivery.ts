import { handleAnswerFeedbackRequest } from "./answer-feedback";
import { Hono } from "hono";
import type { Env } from "../../env";
import { handleAssetRequest } from "./assets";
import { handleBootstrapRequest } from "./bootstrap";
import { handleItemRequest, handleManifestRequest } from "./content";
import { handleAttemptHistoryRequest } from "./history";

export function createStudentDeliveryRoutes(): Hono<{ Bindings: Env }> {
  const delivery = new Hono<{ Bindings: Env }>();

  delivery.post("/bootstrap", handleBootstrapRequest);
  delivery.get("/content/manifest", handleManifestRequest);
  delivery.get("/content/items/:itemId", handleItemRequest);
  delivery.get("/content/assets/:assetId", handleAssetRequest);
  delivery.get("/attempts/:attemptId/feedback", handleAnswerFeedbackRequest);
  delivery.get("/attempts/:attemptId/history", handleAttemptHistoryRequest);

  return delivery;
}
