import { Hono } from "hono";
import type { Env } from "../../env";
import {
  handleInstitutionalCallbackRequest,
  handleInstitutionalLoginRequest,
  handleLogoutRequest,
  handleSessionReadRequest,
} from "./session";

export function createAuthRoutes(): Hono<{ Bindings: Env }> {
  const auth = new Hono<{ Bindings: Env }>();

  auth.get("/session", handleSessionReadRequest);
  auth.post("/logout", handleLogoutRequest);
  auth.get("/institutional/login", handleInstitutionalLoginRequest);
  auth.get("/institutional/callback", handleInstitutionalCallbackRequest);

  return auth;
}
