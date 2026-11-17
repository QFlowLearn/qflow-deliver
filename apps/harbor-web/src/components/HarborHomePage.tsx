import { computed, useSetup } from "@/lib/preact-reactivity";
import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";

export default function HarborHomePage(props: { navigateTo: (page: HarborPage) => void }) {
  const runtime = useHarborRuntime();
  const {
    currentClientSessionId,
    errorMessage,
    accessCodeForm,
    bootstrappedSession,
    institutionalSession,
    launchAccessCode,
    launchPreview,
    launchStudentAssignment,
    openStudentSafeExamBrowser,
    previewForm,
    signOutInstitutionalSession,
    signedInLearnerEmail,
    signedInLearnerLabel,
    studentAssignments,
    studentAssignmentsError,
    studentAssignmentsLoading,
    studentSafeExamBrowserLaunches,
  } = runtime;

  const state = useSetup(() => {
    const demoConfig = computed<DemoConfig | null>(() => {
      const url = new URL(window.location.href);
      const accessCode = readParam(url, "demoAccessCode");
      const assessmentVersionId = readParam(url, "demoAssessmentVersionId");

      if (!accessCode || !assessmentVersionId) return null;

      return {
        accessCode,
        assessmentVersionId,
        candidateId: readParam(url, "demoCandidateId", "demo_student"),
        candidateName: readParam(url, "demoCandidateName", "Demo Student"),
        previewActorId: readParam(url, "demoPreviewActorId", "preview_demo"),
        previewActorDisplayName: readParam(
          url,
          "demoPreviewActorDisplayName",
          "Instructor Preview",
        ),
        title: readParam(url, "demoTitle", "Presidents Sampler"),
      };
    });

    const prioritizedAssignments = computed(() =>
      [...studentAssignments.value].sort((left, right) => {
        if (left.attemptStatus === "in-progress" && right.attemptStatus !== "in-progress") {
          return -1;
        }
        if (right.attemptStatus === "in-progress" && left.attemptStatus !== "in-progress") {
          return 1;
        }
        return left.title.localeCompare(right.title);
      }),
    );

    const featuredPanelTitle = computed(() => {
      if (demoConfig.value) return demoConfig.value.title;
      if (institutionalSession.value) return "Your assessments";
      return "Start an assessment";
    });

    return { demoConfig, featuredPanelTitle, prioritizedAssignments };
  });

  async function startFeaturedStudentDemo(): Promise<void> {
    if (!state.demoConfig.value) {
      props.navigateTo("launch");
      return;
    }

    accessCodeForm.accessCode = state.demoConfig.value.accessCode;
    accessCodeForm.assessmentVersionId = state.demoConfig.value.assessmentVersionId;
    accessCodeForm.actorId = state.demoConfig.value.candidateId;
    accessCodeForm.actorDisplayName = state.demoConfig.value.candidateName;
    await launchAccessCode();
  }

  async function startFeaturedPreview(): Promise<void> {
    if (!state.demoConfig.value) {
      props.navigateTo("launch");
      return;
    }

    previewForm.assessmentVersionId = state.demoConfig.value.assessmentVersionId;
    previewForm.actorId = state.demoConfig.value.previewActorId;
    previewForm.actorDisplayName = state.demoConfig.value.previewActorDisplayName;
    await launchPreview();
  }

  return (
    <section class="home-page">
      <section class="home-hero">
        <div class="hero-copy">
          <h1>{state.featuredPanelTitle.value}</h1>
          {institutionalSession.value && signedInLearnerEmail.value && (
            <p class="page-lede">{signedInLearnerEmail.value}</p>
          )}
          {institutionalSession.value && (
            <strong class="signed-in-learner" data-testid="signed-in-learner">
              {signedInLearnerLabel.value}
            </strong>
          )}
        </div>

        <div class="hero-actions">
          {bootstrappedSession.value && (
            <button
              class="primary-action"
              type="button"
              data-testid="resume-session-button"
              onClick={() => props.navigateTo("session")}
            >
              Resume session
            </button>
          )}
          {state.demoConfig.value && (
            <button
              class={bootstrappedSession.value ? "secondary-action" : "primary-action"}
              type="button"
              data-testid="featured-demo-student-button"
              onClick={() => void startFeaturedStudentDemo()}
            >
              Take demo
            </button>
          )}
          {state.demoConfig.value ? (
            <button
              class="secondary-action"
              type="button"
              data-testid="featured-demo-preview-button"
              onClick={() => void startFeaturedPreview()}
            >
              Instructor preview
            </button>
          ) : !institutionalSession.value ? (
            <button
              class="secondary-action"
              type="button"
              data-testid="password-login-button"
              onClick={() => props.navigateTo("login")}
            >
              Sign in
            </button>
          ) : null}
          {institutionalSession.value && (
            <button
              class="secondary-action"
              type="button"
              data-testid="institutional-logout-button"
              onClick={() => void signOutInstitutionalSession()}
            >
              Sign out
            </button>
          )}
        </div>
      </section>

      <section class="assessment-board">
        <div class="board-header">
          <h2>
            {institutionalSession.value
              ? "Assessments"
              : state.demoConfig.value
                ? "Institutional sign-in"
                : "Assessments"}
          </h2>
        </div>

        {errorMessage.value.includes("another workstation") && (
          <section class="assessment-empty assessment-empty--error" role="alert">
            <p>{errorMessage.value}</p>
            <dl>
              <dt>Replacement workstation code</dt>
              <dd data-testid="replacement-workstation-code" class="mono">
                {currentClientSessionId.value}
              </dd>
            </dl>
          </section>
        )}
        {!institutionalSession.value ? (
          <section class="assessment-empty">
            <strong>
              {state.demoConfig.value
                ? "The demo is ready above. Sign in to view institutional assessments."
                : "Sign in to view assessments."}
            </strong>
          </section>
        ) : studentAssignmentsLoading.value ? (
          <section class="assessment-empty">
            <strong>Loading</strong>
          </section>
        ) : studentAssignmentsError.value ? (
          <section class="assessment-empty assessment-empty--error" role="alert">
            <strong>Unavailable</strong>
            <p>{studentAssignmentsError.value}</p>
          </section>
        ) : state.prioritizedAssignments.value.length === 0 ? (
          <section class="assessment-empty">
            <strong>No assessments</strong>
          </section>
        ) : (
          <section class="assessment-grid" data-testid="student-assessment-list">
            {state.prioritizedAssignments.value.map((assignment) => {
              const safeExamBrowserLaunch =
                studentSafeExamBrowserLaunches.value[assignment.assignmentId];
              return (
                <article
                  key={assignment.assignmentId}
                  class="assessment-card"
                  data-status={assignment.attemptStatus}
                >
                  <div class="assessment-topline">
                    <h3>{assignment.title}</h3>
                    <span class="assessment-status">
                      {formatAttemptStatus(assignment.attemptStatus)}
                    </span>
                  </div>
                  <p class="meta-line">
                    {formatWindow(assignment.availableFrom)} -{" "}
                    {formatWindow(assignment.availableUntil)}
                    <span class="meta-sep" />
                    {assignment.remainingAttempts} attempt
                    {assignment.remainingAttempts === 1 ? "" : "s"} remaining
                  </p>
                  {assignment.safeExamBrowser?.required && (
                    <p class="meta-line meta-line--secure">Safe Exam Browser required</p>
                  )}

                  <button
                    class="primary-action"
                    type="button"
                    disabled={!assignment.canLaunch}
                    data-testid={`student-assessment-action-${assignment.assignmentId}`}
                    onClick={() => void handleAssignmentAction(assignment)}
                  >
                    {buildActionLabel(assignment)}
                  </button>
                  {safeExamBrowserLaunch && (
                    <a
                      class="secondary-action seb-download-link"
                      href={safeExamBrowserLaunch.configDownloadUrl}
                      download={safeExamBrowserLaunch.configFileName}
                    >
                      Download .seb
                    </a>
                  )}
                </article>
              );
            })}
          </section>
        )}
      </section>
    </section>
  );

  async function handleAssignmentAction(assignment: StudentAssignmentAction): Promise<void> {
    if (
      assignment.safeExamBrowser?.required &&
      assignment.safeExamBrowser.generatedConfigAvailable
    ) {
      await openStudentSafeExamBrowser(assignment.assignmentId);
      return;
    }

    await launchStudentAssignment(assignment.assignmentId);
  }
}

interface DemoConfig {
  accessCode: string;
  assessmentVersionId: string;
  candidateId: string;
  candidateName: string;
  previewActorId: string;
  previewActorDisplayName: string;
  title: string;
}

interface StudentAssignmentAction {
  assignmentId: string;
  safeExamBrowser: {
    generatedConfigAvailable: boolean;
    required: boolean;
  } | null;
}

function buildActionLabel(input: {
  attemptStatus: "not-started" | "in-progress" | "submitted" | "ineligible";
  attemptCount: number;
  canLaunch: boolean;
  safeExamBrowser: {
    generatedConfigAvailable: boolean;
    required: boolean;
  } | null;
}): string {
  if (
    input.canLaunch &&
    input.safeExamBrowser?.required &&
    input.safeExamBrowser.generatedConfigAvailable
  ) {
    return input.attemptStatus === "in-progress"
      ? "Resume in Safe Exam Browser"
      : "Open in Safe Exam Browser";
  }

  if (input.attemptStatus === "in-progress") return "Resume Attempt";
  if (!input.canLaunch) return "Unavailable";
  return input.attemptCount > 0 ? "Start Another Attempt" : "Start Assessment";
}

function formatAttemptStatus(
  status: "not-started" | "in-progress" | "submitted" | "ineligible",
): string {
  switch (status) {
    case "not-started":
      return "Ready";
    case "in-progress":
      return "In progress";
    case "submitted":
      return "Submitted";
    case "ineligible":
      return "Unavailable";
  }
}

function formatWindow(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Open";
}

function readParam(url: URL, key: string, fallback = ""): string {
  const value = url.searchParams.get(key);
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}
