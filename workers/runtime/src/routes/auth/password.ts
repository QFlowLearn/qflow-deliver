import { Hono } from "hono";
import type { Env } from "../../env";
import {
  handlePasswordForgotRequest,
  handlePasswordLoginRequest,
  handlePasswordResetRequest,
} from "./password-handlers";

export function createPasswordAuthRoutes(): Hono<{ Bindings: Env }> {
  const passwordAuth = new Hono<{ Bindings: Env }>();

  passwordAuth.post("/login", handlePasswordLoginRequest);
  passwordAuth.post("/forgot", handlePasswordForgotRequest);
  passwordAuth.post("/reset", handlePasswordResetRequest);

  return passwordAuth;
}
