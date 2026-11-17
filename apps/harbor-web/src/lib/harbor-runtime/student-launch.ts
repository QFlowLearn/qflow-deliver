import { computed, reactive, ref } from "../preact-reactivity";
import {
  bootstrapAccessCode,
  bootstrapPreview,
  getInitialAccessCodeForm,
  getInitialPreviewForm,
  type AccessCodeLaunchForm,
  type BootstrappedSession,
  type PreviewLaunchForm,
} from "../bootstrap-client";
import {
  beginInstitutionalLogin,
  loadInstitutionalSession,
  loadStudentAssignments,
  logoutInstitutionalSession,
  requestStudentBootstrap,
  requestStudentSafeExamBrowserLaunch,
  RuntimeSessionError,
  type RuntimeInstitutionalSession,
  type RuntimeStudentAssignments,
  type RuntimeStudentSafeExamBrowserLaunch,
} from "../runtime-session";

export function createStudentLaunchRuntime(input: {
  runLaunch(action: () => Promise<void>): Promise<void>;
  readOrCreateClientSessionId(): string;
  setCurrentClientSessionId(value: string): void;
  applyBootstrappedSession(session: BootstrappedSession): Promise<void>;
  formatError(error: unknown): string;
}) {
  const previewForm = reactive<PreviewLaunchForm>(getInitialPreviewForm());
  const accessCodeForm = reactive<AccessCodeLaunchForm>(getInitialAccessCodeForm());
  const institutionalSession = ref<RuntimeInstitutionalSession | null>(null);
  const studentAssignments = ref<RuntimeStudentAssignments["assignments"]>([]);
  const studentSafeExamBrowserLaunches = ref<Record<string, RuntimeStudentSafeExamBrowserLaunch>>(
    {},
  );
  const studentAssignmentsLoading = ref(false);
  const studentAssignmentsError = ref("");

  const signedInLearnerLabel = computed(
    () => institutionalSession.value?.learner.displayName ?? "Institutional sign-in required",
  );
  const signedInLearnerEmail = computed(() => institutionalSession.value?.learner.email ?? "");

  async function launchPreview(): Promise<void> {
    await input.runLaunch(async () => {
      const clientSessionId = input.readOrCreateClientSessionId();
      input.setCurrentClientSessionId(clientSessionId);
      await input.applyBootstrappedSession(await bootstrapPreview(previewForm, clientSessionId));
    });
  }

  async function launchAccessCode(): Promise<void> {
    await input.runLaunch(async () => {
      const clientSessionId = input.readOrCreateClientSessionId();
      input.setCurrentClientSessionId(clientSessionId);
      await input.applyBootstrappedSession(
        await bootstrapAccessCode(accessCodeForm, clientSessionId),
      );
    });
  }

  async function launchStudentAssignment(assignmentId: string): Promise<void> {
    await input.runLaunch(async () => {
      const clientSessionId = input.readOrCreateClientSessionId();
      input.setCurrentClientSessionId(clientSessionId);
      await input.applyBootstrappedSession({
        ...(await requestStudentBootstrap({
          assignmentId,
          source: "institutional-sso",
          clientSessionId,
        })),
        mode: "institutional-sso",
        launchedFromQuery: false,
      });
      await refreshStudentAssignments();
    });
  }

  async function openStudentSafeExamBrowser(assignmentId: string): Promise<void> {
    studentAssignmentsError.value = "";

    try {
      const launch = await requestStudentSafeExamBrowserLaunch(assignmentId);
      studentSafeExamBrowserLaunches.value = {
        ...studentSafeExamBrowserLaunches.value,
        [assignmentId]: launch,
      };
      window.location.assign(launch.configLaunchUrl);
    } catch (error) {
      studentAssignmentsError.value = input.formatError(error);
    }
  }

  async function refreshInstitutionalSession(): Promise<void> {
    try {
      institutionalSession.value = await loadInstitutionalSession();
      studentAssignmentsError.value = "";
      await refreshStudentAssignments();
    } catch (error) {
      if (error instanceof RuntimeSessionError && error.status === 401) {
        institutionalSession.value = null;
        clearSessionState();
        return;
      }

      institutionalSession.value = null;
      clearSessionState();
      studentAssignmentsError.value = input.formatError(error);
    }
  }

  async function refreshStudentAssignments(): Promise<void> {
    if (!institutionalSession.value) {
      clearSessionState();
      return;
    }

    studentAssignmentsLoading.value = true;
    studentAssignmentsError.value = "";

    try {
      const payload = await loadStudentAssignments();
      studentAssignments.value = payload.assignments;
      const assignmentIds = new Set(
        payload.assignments.map((assignment) => assignment.assignmentId),
      );
      studentSafeExamBrowserLaunches.value = Object.fromEntries(
        Object.entries(studentSafeExamBrowserLaunches.value).filter(([assignmentId]) =>
          assignmentIds.has(assignmentId),
        ),
      );
    } catch (error) {
      studentAssignments.value = [];
      studentSafeExamBrowserLaunches.value = {};
      studentAssignmentsError.value = input.formatError(error);
    } finally {
      studentAssignmentsLoading.value = false;
    }
  }

  function startInstitutionalLogin(redirectTo = window.location.pathname): void {
    beginInstitutionalLogin({
      redirectTo,
    });
  }

  async function signOutInstitutionalSession(): Promise<void> {
    await logoutInstitutionalSession();
    institutionalSession.value = null;
    clearSessionState();
  }

  function clearSessionState(): void {
    studentAssignments.value = [];
    studentSafeExamBrowserLaunches.value = {};
    studentAssignmentsError.value = "";
  }

  return {
    accessCodeForm,
    clearSessionState,
    institutionalSession,
    launchAccessCode,
    launchPreview,
    launchStudentAssignment,
    openStudentSafeExamBrowser,
    previewForm,
    refreshInstitutionalSession,
    refreshStudentAssignments,
    signedInLearnerEmail,
    signedInLearnerLabel,
    signOutInstitutionalSession,
    startInstitutionalLogin,
    studentAssignments,
    studentAssignmentsError,
    studentAssignmentsLoading,
    studentSafeExamBrowserLaunches,
  };
}
