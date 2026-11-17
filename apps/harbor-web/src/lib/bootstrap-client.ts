import type { LaunchMode } from "@harbor/attempt-protocol";

import {
  exchangeRuntimeBootstrapToken,
  requestAccessCodeBootstrap,
  requestPreviewBootstrap,
  requestStudentBootstrap,
  type RuntimeBootstrapSession,
} from "./runtime-session";

export interface PreviewLaunchForm {
  assessmentVersionId: string;
  actorId: string;
  actorDisplayName: string;
}

export interface AccessCodeLaunchForm {
  accessCode: string;
  assessmentVersionId: string;
  actorId: string;
  actorDisplayName: string;
}

export interface BootstrappedSession extends RuntimeBootstrapSession {
  mode: LaunchMode;
  launchedFromQuery: boolean;
}

export function getInitialPreviewForm(url: URL = new URL(window.location.href)): PreviewLaunchForm {
  return {
    assessmentVersionId: readParam(url, "assessmentVersionId"),
    actorId: readParam(url, "previewActorId"),
    actorDisplayName: readParam(url, "previewActorDisplayName", "Instructor Preview"),
  };
}

export function getInitialAccessCodeForm(
  url: URL = new URL(window.location.href),
): AccessCodeLaunchForm {
  return {
    accessCode: readParam(url, "accessCode"),
    assessmentVersionId: readParam(url, "accessCodeAssessmentVersionId"),
    actorId: readParam(url, "candidateId"),
    actorDisplayName: readParam(url, "candidateName", "Student Candidate"),
  };
}

export async function bootstrapPreview(
  form: PreviewLaunchForm,
  clientSessionId?: string,
): Promise<BootstrappedSession> {
  const session = await requestPreviewBootstrap({
    assessmentVersionId: form.assessmentVersionId.trim(),
    actor: {
      id: form.actorId,
      displayName: form.actorDisplayName,
    },
    clientSessionId,
  });

  return {
    ...session,
    mode: "preview",
    launchedFromQuery: false,
  };
}

export async function bootstrapAccessCode(
  form: AccessCodeLaunchForm,
  clientSessionId?: string,
): Promise<BootstrappedSession> {
  const session = await requestAccessCodeBootstrap({
    accessCode: form.accessCode.trim(),
    assessmentVersionId: form.assessmentVersionId.trim() || undefined,
    actor: {
      id: form.actorId,
      displayName: form.actorDisplayName,
    },
    clientSessionId,
  });

  return {
    ...session,
    mode: "access-code",
    launchedFromQuery: false,
  };
}

export async function maybeBootstrapFromQuery(
  url: URL = new URL(window.location.href),
  clientSessionId?: string,
): Promise<BootstrappedSession | null> {
  if (!isDeliverySessionLocation(url)) return null;
  const mode = readLaunchMode(url);
  const bootstrapToken = readParam(url, "bootstrapToken");

  if (bootstrapToken && (mode === "institutional-sso" || mode === "lti")) {
    const payload = await exchangeRuntimeBootstrapToken(bootstrapToken, clientSessionId);

    return {
      envelope: {
        bootstrapToken,
        exchangeUrl: "/api/bootstrap",
        expiresAt: "",
        launch: payload.launch,
      },
      payload,
      mode,
      launchedFromQuery: true,
    };
  }

  if (mode === "institutional-sso") {
    const assignmentId = readParam(url, "assignmentId");
    const safeExamBrowserLaunchToken = readParam(url, "sebLaunchToken");
    if (!assignmentId || !safeExamBrowserLaunchToken) {
      return null;
    }

    return {
      ...(await requestStudentBootstrap({
        assignmentId,
        source: "institutional-sso",
        clientSessionId,
        safeExamBrowserLaunchToken,
      })),
      mode,
      launchedFromQuery: true,
    };
  }

  if (mode === "preview") {
    const assessmentVersionId = readParam(url, "assessmentVersionId");
    if (!assessmentVersionId) {
      return null;
    }

    const session = await requestPreviewBootstrap({
      assessmentVersionId,
      actor: {
        id: readParam(url, "previewActorId"),
        displayName: readParam(url, "previewActorDisplayName", "Instructor Preview"),
      },
      clientSessionId,
    });

    return {
      ...session,
      mode,
      launchedFromQuery: true,
    };
  }

  if (mode === "access-code") {
    const accessCode = readParam(url, "accessCode");
    if (!accessCode) {
      return null;
    }

    const session = await requestAccessCodeBootstrap({
      accessCode,
      assessmentVersionId: readParam(url, "accessCodeAssessmentVersionId") || undefined,
      actor: {
        id: readParam(url, "candidateId"),
        displayName: readParam(url, "candidateName", "Student Candidate"),
      },
      clientSessionId,
    });

    return {
      ...session,
      mode,
      launchedFromQuery: true,
    };
  }

  return null;
}

/** Workspace destinations must never launch or restore a learner attempt during startup. */
export function isDeliverySessionLocation(url: URL): boolean {
  return ["/", "/session", "/details", "/history"].includes(url.pathname);
}

function readLaunchMode(url: URL): LaunchMode | null {
  const explicitMode = url.searchParams.get("mode");
  if (
    explicitMode === "preview" ||
    explicitMode === "access-code" ||
    explicitMode === "institutional-sso" ||
    explicitMode === "lti"
  ) {
    return explicitMode;
  }

  if (url.searchParams.get("accessCode")) {
    return "access-code";
  }

  if (url.searchParams.get("assessmentVersionId")) {
    return "preview";
  }

  return null;
}

function readParam(url: URL, key: string, fallback = ""): string {
  const value = url.searchParams.get(key);
  if (typeof value !== "string") {
    return fallback;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}
