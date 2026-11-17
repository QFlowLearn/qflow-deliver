import { managementLoginReturn } from "@/lib/management-login-return";
import type { HarborPage } from "@/App";
import { reactive, useSetup } from "@/lib/preact-reactivity";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import {
  completePasswordReset,
  loginWithPassword,
  requestPasswordReset,
  RuntimeSessionError,
} from "@/lib/runtime-session";

type PasswordAuthMode = "login" | "forgot" | "reset";

export default function HarborPasswordAuthPage(props: {
  mode: PasswordAuthMode;
  navigateTo: (page: HarborPage, options?: { replace?: boolean }) => void;
}) {
  const runtime = useHarborRuntime();
  const state = useSetup(() => {
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token")?.trim() ?? "";
    if (props.mode === "reset" && token) {
      url.searchParams.delete("token");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
    return reactive({
      tenantId: url.searchParams.get("tenantId")?.trim() ?? "",
      usernameOrEmail: "",
      password: "",
      token,
      showPassword: false,
      submitting: false,
      error: "",
      notice: "",
    });
  });

  async function submitLogin(event: Event): Promise<void> {
    event.preventDefault();
    state.error = "";
    state.notice = "";
    state.submitting = true;

    try {
      await loginWithPassword({
        tenantId: normalizeOptional(state.tenantId),
        usernameOrEmail: state.usernameOrEmail,
        password: state.password,
      });
      await runtime.refreshInstitutionalSession();
      const returnTo = new URL(window.location.href).searchParams.get("returnTo");
      props.navigateTo(returnTo === "assessments" ? "assessments" : "home");
    } catch (error) {
      state.error = formatAuthError(error);
    } finally {
      state.submitting = false;
    }
  }

  async function submitForgot(event: Event): Promise<void> {
    event.preventDefault();
    state.error = "";
    state.notice = "";
    state.submitting = true;

    try {
      await requestPasswordReset({
        tenantId: normalizeOptional(state.tenantId),
        usernameOrEmail: state.usernameOrEmail,
      });
      state.notice = "If the account exists, a reset link has been sent.";
    } catch (error) {
      state.error = formatAuthError(error);
    } finally {
      state.submitting = false;
    }
  }

  async function submitReset(event: Event): Promise<void> {
    event.preventDefault();
    state.error = "";
    state.notice = "";
    state.submitting = true;

    try {
      await completePasswordReset({
        token: state.token,
        password: state.password,
      });
      state.notice = "Your password has been reset. You can sign in now.";
      state.password = "";
    } catch (error) {
      state.error = formatAuthError(error);
    } finally {
      state.submitting = false;
    }
  }

  if (props.mode === "forgot") {
    return (
      <section class="password-auth-page">
        <AuthHeader title="Reset password" body="Enter the username or email on your account." />
        <form
          class="password-auth-form"
          method="post"
          onSubmit={(event) => void submitForgot(event)}
        >
          <TextField
            id="forgot-username"
            label="Username or email"
            name="username"
            value={state.usernameOrEmail}
            autocomplete="username"
            enterkeyhint="done"
            required
            onInput={(value) => {
              state.usernameOrEmail = value;
              state.error = "";
            }}
          />
          <TenantField
            value={state.tenantId}
            onInput={(value) => {
              state.tenantId = value;
            }}
          />
          <FormStatus error={state.error} notice={state.notice} />
          <div class="password-auth-actions">
            <button class="primary-action" type="submit" disabled={state.submitting}>
              {state.submitting ? "Sending" : "Send reset link"}
            </button>
            <button
              class="secondary-action"
              type="button"
              onClick={() => props.navigateTo("login")}
            >
              Back to sign in
            </button>
          </div>
        </form>
      </section>
    );
  }

  if (props.mode === "reset") {
    return (
      <section class="password-auth-page">
        <AuthHeader title="Choose a new password" body="Use the reset link from your email." />
        <form
          class="password-auth-form"
          method="post"
          onSubmit={(event) => void submitReset(event)}
        >
          <TextField
            id="reset-token"
            label="Reset token"
            name="token"
            value={state.token}
            autocomplete="off"
            enterkeyhint="next"
            required
            onInput={(value) => {
              state.token = value;
              state.error = "";
            }}
          />
          <PasswordField
            id="new-password"
            label="New password"
            name="new-password"
            autocomplete="new-password"
            value={state.password}
            showPassword={state.showPassword}
            onPasswordInput={(value) => {
              state.password = value;
              state.error = "";
            }}
            onShowPasswordChange={(value) => {
              state.showPassword = value;
            }}
          />
          <FormStatus error={state.error} notice={state.notice} />
          <div class="password-auth-actions">
            <button class="primary-action" type="submit" disabled={state.submitting}>
              {state.submitting ? "Resetting" : "Reset password"}
            </button>
            <button
              class="secondary-action"
              type="button"
              onClick={() => props.navigateTo("login")}
            >
              Sign in
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section class="password-auth-page">
      <AuthHeader title="Sign in" body="Use the account created by your workspace administrator." />
      <form class="password-auth-form" method="post" onSubmit={(event) => void submitLogin(event)}>
        <TextField
          id="username"
          label="Username or email"
          name="username"
          value={state.usernameOrEmail}
          autocomplete="username"
          enterkeyhint="next"
          required
          onInput={(value) => {
            state.usernameOrEmail = value;
            state.error = "";
          }}
        />
        <PasswordField
          id="current-password"
          label="Password"
          name="password"
          autocomplete="current-password"
          value={state.password}
          showPassword={state.showPassword}
          onPasswordInput={(value) => {
            state.password = value;
            state.error = "";
          }}
          onShowPasswordChange={(value) => {
            state.showPassword = value;
          }}
        />
        <TenantField
          value={state.tenantId}
          onInput={(value) => {
            state.tenantId = value;
          }}
        />
        <FormStatus error={state.error} notice={state.notice} />
        <div class="password-auth-actions">
          <button class="primary-action" type="submit" disabled={state.submitting}>
            {state.submitting ? "Signing in" : "Sign in"}
          </button>
          <button
            class="secondary-action"
            type="button"
            onClick={() => props.navigateTo("forgot-password")}
          >
            Forgot password
          </button>
          <button
            class="secondary-action"
            type="button"
            data-testid="institutional-login-button"
            onClick={() =>
              runtime.startInstitutionalLogin(managementLoginReturn(new URL(window.location.href)))
            }
          >
            Institutional sign-in
          </button>
        </div>
      </form>
    </section>
  );
}

function AuthHeader(props: { title: string; body: string }) {
  return (
    <header class="password-auth-header">
      <h1>{props.title}</h1>
      <p class="page-lede">{props.body}</p>
    </header>
  );
}

function TextField(props: {
  id: string;
  label: string;
  name: string;
  value: string;
  autocomplete: string;
  enterkeyhint: "next" | "done";
  required?: boolean;
  onInput: (value: string) => void;
}) {
  return (
    <label class="password-auth-field" for={props.id}>
      <span>{props.label}</span>
      <input
        id={props.id}
        name={props.name}
        type="text"
        autocomplete={props.autocomplete}
        enterkeyhint={props.enterkeyhint}
        required={props.required}
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function PasswordField(props: {
  id: string;
  label: string;
  name: string;
  autocomplete: "current-password" | "new-password";
  value: string;
  showPassword: boolean;
  onPasswordInput: (value: string) => void;
  onShowPasswordChange: (value: boolean) => void;
}) {
  return (
    <div class="password-auth-field">
      <label for={props.id}>{props.label}</label>
      <input
        id={props.id}
        name={props.name}
        type={props.showPassword ? "text" : "password"}
        autocomplete={props.autocomplete}
        enterkeyhint="done"
        minlength={12}
        required
        value={props.value}
        onInput={(event) => props.onPasswordInput(event.currentTarget.value)}
      />
      <label class="password-auth-checkbox" for={`${props.id}-visible`}>
        <input
          id={`${props.id}-visible`}
          type="checkbox"
          checked={props.showPassword}
          onInput={(event) => props.onShowPasswordChange(event.currentTarget.checked)}
        />
        <span>Show password</span>
      </label>
    </div>
  );
}

function TenantField(props: { value: string; onInput: (value: string) => void }) {
  return (
    <label class="password-auth-field password-auth-field--compact" for="tenant-id">
      <span>Tenant</span>
      <input
        id="tenant-id"
        name="tenantId"
        type="text"
        autocomplete="off"
        placeholder="tenant_local_demo"
        value={props.value}
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function FormStatus(props: { error: string; notice: string }) {
  return (
    <>
      {props.error && (
        <p class="password-auth-error" role="alert">
          {props.error}
        </p>
      )}
      {props.notice && (
        <p class="password-auth-notice" role="status">
          {props.notice}
        </p>
      )}
    </>
  );
}

function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function formatAuthError(error: unknown): string {
  if (error instanceof RuntimeSessionError) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "The request could not be completed.";
}
