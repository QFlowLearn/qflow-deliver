import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  useSetup,
  watch,
} from "@/lib/preact-reactivity";

import HarborDetailsPage from "@/components/HarborDetailsPage";
import HarborHistoryPage from "@/components/HarborHistoryPage";
import HarborHomePage from "@/components/HarborHomePage";
import HarborInstructorAnalyticsPage from "@/components/HarborInstructorAnalyticsPage";
import HarborInstructorAssessmentsPage from "@/components/HarborInstructorAssessmentsPage";
import HarborInstructorLmsPage from "@/components/HarborInstructorLmsPage";
import HarborManualScoringPage from "@/components/HarborManualScoringPage";
import HarborInstructorRosterPage from "@/components/HarborInstructorRosterPage";
import HarborLaunchPage from "@/components/HarborLaunchPage";
import HarborPasswordAuthPage from "@/components/HarborPasswordAuthPage";
import HarborResultsOpsPage from "@/components/HarborResultsOpsPage";
import HarborSessionPage from "@/components/HarborSessionPage";
import { provideHarborRuntime } from "@/lib/harbor-runtime";

export type HarborPage =
  | "home"
  | "assessments"
  | "analytics"
  | "roster"
  | "manual-scoring"
  | "lms"
  | "results-ops"
  | "launch"
  | "session"
  | "history"
  | "login"
  | "forgot-password"
  | "reset-password"
  | "details";

type NavItem = {
  id: HarborPage;
  label: string;
};

const PATH_BY_PAGE: Record<HarborPage, string> = {
  home: "/",
  assessments: "/assessments",
  analytics: "/analytics",
  roster: "/roster",
  "manual-scoring": "/manual-scoring",
  lms: "/lms",
  "results-ops": "/results-ops",
  launch: "/launch",
  session: "/session",
  history: "/history",
  login: "/login",
  "forgot-password": "/forgot-password",
  "reset-password": "/reset-password",
  details: "/details",
};

function createNavItem(id: HarborPage, label: string): NavItem {
  return { id, label };
}

function readPageFromLocation(): HarborPage {
  switch (window.location.pathname) {
    case "/assessments":
    case "/assignments":
      return "assessments";
    case "/analytics":
      return "analytics";
    case "/roster":
      return "roster";
    case "/manual-scoring":
      return "manual-scoring";
    case "/lms":
      return "lms";
    case "/results-ops":
      return "results-ops";
    case "/launch":
      // A published-version management link opens the instructor workspace.
      if (
        new URL(window.location.href).searchParams.has("assessmentVersionId") &&
        !new URL(window.location.href).searchParams.has("mode")
      )
        return "assessments";
      return "launch";
    case "/session":
      return "session";
    case "/history":
      return "history";
    case "/login":
      return "login";
    case "/forgot-password":
      return "forgot-password";
    case "/reset-password":
      return "reset-password";
    case "/details":
      return "details";
    default:
      return "home";
  }
}

function buildPageHref(page: HarborPage): string {
  const url = new URL(window.location.href);
  url.pathname = PATH_BY_PAGE[page];
  return `${url.pathname}${url.search}${url.hash}`;
}

export default function App() {
  const state = useSetup(() => {
    const runtime = provideHarborRuntime();
    const {
      assessmentHistory,
      bootstrappedSession,
      deliveryContextState,
      errorMessage,
      instructorAssignmentCount,
      instructorAssignmentError,
      instructorRosterError,
      instructorRosterRows,
      launchActorLabel,
      loading,
      resultsOpsError,
      resultsOpsLoading,
      resultsOpsRows,
      selectedInstructorAssignmentId,
      selectedInstructorAssignmentTitle,
    } = runtime;
    const currentPage = ref<HarborPage>(readPageFromLocation());
    const operatorWorkspacePages = new Set<HarborPage>([
      "assessments",
      "analytics",
      "roster",
      "manual-scoring",
      "lms",
      "results-ops",
      "launch",
    ]);

    function syncPageFromLocation(): void {
      currentPage.value = readPageFromLocation();
    }

    function navigateTo(page: HarborPage, options?: { replace?: boolean }): void {
      currentPage.value = page;
      const href = buildPageHref(page);
      if (options?.replace) {
        window.history.replaceState({}, "", href);
        return;
      }
      window.history.pushState({}, "", href);
    }

    const pageSummary = computed(() => {
      if (loading.value) return "Loading";

      if (currentPage.value === "assessments") {
        if (instructorAssignmentError.value) return "Unavailable";
        return instructorAssignmentCount.value === 0
          ? "No delivery assignments"
          : `${instructorAssignmentCount.value} assignments`;
      }

      if (currentPage.value === "roster") {
        if (instructorRosterError.value) return "Unavailable";
        if (!selectedInstructorAssignmentId.value) return "Select assignment";
        return `${instructorRosterRows.value.length} learners`;
      }

      if (currentPage.value === "analytics") {
        if (instructorRosterError.value) return "Unavailable";
        if (!selectedInstructorAssignmentId.value) return "Select assignment";
        return `${instructorRosterRows.value.length} learner signals`;
      }

      if (currentPage.value === "manual-scoring") {
        if (!selectedInstructorAssignmentId.value) return "All assignments";
        return "Manual review";
      }

      if (currentPage.value === "results-ops") {
        if (resultsOpsLoading.value) return "Loading";
        if (resultsOpsError.value) return "Unavailable";
        return resultsOpsRows.value.length === 0
          ? "No open items"
          : `${resultsOpsRows.value.length} open item${resultsOpsRows.value.length === 1 ? "" : "s"}`;
      }

      if (currentPage.value === "lms") return "LTI evidence";
      if (errorMessage.value) return errorMessage.value;
      if (!bootstrappedSession.value) return "";
      return launchActorLabel.value;
    });

    const isOperatorWorkspace = computed(() => {
      if (operatorWorkspacePages.has(currentPage.value)) return true;
      return currentPage.value === "history" && selectedInstructorAssignmentId.value.length > 0;
    });
    const isSessionPage = computed(() => currentPage.value === "session");
    const railBrandContext = computed(() =>
      isOperatorWorkspace.value ? "Delivery workspace" : "Delivery",
    );
    const studentNavItems = computed<NavItem[]>(() => {
      const items = [createNavItem("home", "Home")];
      if (bootstrappedSession.value || currentPage.value === "session") {
        items.push(createNavItem("session", "Session"));
      }
      if (assessmentHistory.value || currentPage.value === "history") {
        items.push(createNavItem("history", "History"));
      }
      if (bootstrappedSession.value || currentPage.value === "details") {
        items.push(createNavItem("details", "Timing & Rules"));
      }
      return items;
    });
    const operatorPrimaryNavItems = computed<NavItem[]>(() => {
      const items = [createNavItem("assessments", "Delivery assignments")];
      if (selectedInstructorAssignmentId.value || currentPage.value === "roster") {
        items.push(createNavItem("roster", "Roster"));
      }
      if (selectedInstructorAssignmentId.value || currentPage.value === "analytics") {
        items.push(createNavItem("analytics", "Analytics"));
      }
      if (selectedInstructorAssignmentId.value || currentPage.value === "manual-scoring") {
        items.push(createNavItem("manual-scoring", "Manual scoring"));
      }
      items.push(createNavItem("lms", "LMS"));
      items.push(createNavItem("results-ops", "Results"));
      items.push(createNavItem("launch", "Launch"));
      return items;
    });
    const operatorSecondaryNavItems = computed<NavItem[]>(() => {
      const items = [createNavItem("home", "Home")];
      if (bootstrappedSession.value || currentPage.value === "session") {
        items.push(createNavItem("session", "Session"));
      }
      if (currentPage.value === "history") items.push(createNavItem("history", "History"));
      return items;
    });
    const railStatusLabel = computed(() => {
      if (isOperatorWorkspace.value) {
        if (currentPage.value === "results-ops") return "Results";
        if (currentPage.value === "manual-scoring") return "Manual scoring";
        if (currentPage.value === "analytics") return "Analytics";
        if (currentPage.value === "lms") return "LMS";
        if (selectedInstructorAssignmentId.value) return selectedInstructorAssignmentTitle.value;
        return "Instructor";
      }
      if (currentPage.value === "history") return "History";
      if (bootstrappedSession.value) return "In progress";
      return "";
    });
    const showRailStatus = computed(
      () =>
        isOperatorWorkspace.value ||
        currentPage.value === "history" ||
        Boolean(bootstrappedSession.value) ||
        Boolean(errorMessage.value) ||
        loading.value,
    );
    const shouldShowDeliveryContextBanner = computed(() => {
      if (!deliveryContextState.value) return false;
      if (!deliveryContextState.value.allowed) return true;
      return (
        deliveryContextState.value.mode === "iframe" ||
        deliveryContextState.value.secureBrowserRequired ||
        deliveryContextState.value.secureBrowserPresent
      );
    });

    watch(
      () => bootstrappedSession.value?.payload.attemptId,
      (attemptId, previousAttemptId) => {
        if (attemptId && attemptId !== previousAttemptId && currentPage.value !== "session") {
          navigateTo("session", { replace: true });
        }
      },
    );

    onMounted(() => {
      window.addEventListener("popstate", syncPageFromLocation);
      if (
        window.location.pathname === "/assignments" ||
        (window.location.pathname === "/launch" && currentPage.value === "assessments")
      ) {
        navigateTo("assessments", { replace: true });
      }
    });

    onBeforeUnmount(() => {
      window.removeEventListener("popstate", syncPageFromLocation);
    });

    return {
      currentPage,
      isOperatorWorkspace,
      isSessionPage,
      navigateTo,
      operatorPrimaryNavItems,
      operatorSecondaryNavItems,
      pageSummary,
      railBrandContext,
      railStatusLabel,
      shouldShowDeliveryContextBanner,
      showRailStatus,
      studentNavItems,
      runtime,
    };
  });

  const {
    deliveryContextBlockedMessage,
    deliveryContextState,
    deliveryContextStatusLabel,
    deliveryContextSupportLabel,
    bootstrappedSession,
    entryMode,
    errorMessage,
    loading,
    policyState,
  } = state.runtime;

  const primaryNav: NavItem[] = state.isOperatorWorkspace.value
    ? state.operatorPrimaryNavItems.value
    : state.studentNavItems.value;

  return (
    <main
      class={`app-shell${state.isSessionPage.value ? " app-shell--session" : ""}`}
      data-testid="harbor-shell"
      data-page={state.currentPage.value}
      data-launch-mode={entryMode.value}
    >
      {!state.isSessionPage.value && (
        <aside class="app-rail">
          <div class="rail-brand">
            <strong class="brand-mark brand-mark--qflow">
              <span>QFlow</span>
              <span>Learn</span>
            </strong>
            <span class="brand-context">{state.railBrandContext.value}</span>
          </div>

          <div class="rail-groups">
            <section class="rail-group">
              <p class="rail-kicker">{state.isOperatorWorkspace.value ? "Workspace" : "Student"}</p>
              <nav class="rail-nav" aria-label="QFlowLearn Delivery">
                {primaryNav.map((item) => (
                  <NavLink
                    key={item.id}
                    item={item}
                    activePage={state.currentPage.value}
                    navigateTo={state.navigateTo}
                  />
                ))}
              </nav>
            </section>

            {state.isOperatorWorkspace.value ? (
              <section class="rail-group rail-group--secondary">
                <p class="rail-kicker">Student</p>
                <nav class="rail-nav" aria-label="Student navigation">
                  {state.operatorSecondaryNavItems.value.map((item) => (
                    <NavLink
                      key={item.id}
                      item={item}
                      activePage={state.currentPage.value}
                      navigateTo={state.navigateTo}
                      secondary
                    />
                  ))}
                </nav>
              </section>
            ) : (
              <section class="rail-group rail-group--secondary">
                <p class="rail-kicker">Instructor</p>
                <nav class="rail-nav" aria-label="Instructor workspace entry">
                  <a
                    href={buildPageHref("assessments")}
                    data-testid="nav-link-assessments"
                    class="rail-link rail-link--secondary"
                    onClick={(event) => {
                      event.preventDefault();
                      state.navigateTo("assessments");
                    }}
                  >
                    <strong>Open Workspace</strong>
                  </a>
                </nav>
              </section>
            )}
          </div>

          {state.showRailStatus.value && (
            <section class="rail-status">
              <strong>{state.railStatusLabel.value}</strong>
              {state.pageSummary.value && <p>{state.pageSummary.value}</p>}
            </section>
          )}
        </aside>
      )}

      <section class={`app-main${state.isSessionPage.value ? " app-main--session" : ""}`}>
        {deliveryContextState.value && state.shouldShowDeliveryContextBanner.value && (
          <section class="context-banner" data-blocked={!deliveryContextState.value.allowed}>
            <div class="context-copy">
              <strong data-testid="delivery-context-status">
                {deliveryContextStatusLabel.value}
              </strong>
              <p>{deliveryContextSupportLabel.value}</p>
            </div>
            {!deliveryContextState.value.allowed && (
              <div class="blocked-banner" data-testid="delivery-context-blocked" role="alert">
                <strong>Launch blocked</strong>
                <p>{deliveryContextBlockedMessage.value}</p>
              </div>
            )}
          </section>
        )}

        {bootstrappedSession.value && policyState.value.operatorMessage && (
          <div
            class="operator-banner"
            data-level={policyState.value.operatorMessage.level}
            data-testid="operator-message-banner"
            role="status"
            aria-live="polite"
          >
            <strong>{policyState.value.operatorMessage.title}</strong>
            <p>{policyState.value.operatorMessage.body}</p>
          </div>
        )}

        <section class={`page-frame${state.isSessionPage.value ? " page-frame--session" : ""}`}>
          {renderPage(state.currentPage.value, state.navigateTo)}
        </section>
      </section>
    </main>
  );
}

function NavLink(props: {
  item: NavItem;
  activePage: HarborPage;
  navigateTo: (page: HarborPage) => void;
  secondary?: boolean;
}) {
  return (
    <a
      href={buildPageHref(props.item.id)}
      data-testid={`nav-link-${props.item.id}`}
      data-active={props.activePage === props.item.id}
      class={`rail-link${props.secondary ? " rail-link--secondary" : ""}`}
      onClick={(event) => {
        event.preventDefault();
        props.navigateTo(props.item.id);
      }}
    >
      <strong>{props.item.label}</strong>
    </a>
  );
}

function renderPage(
  page: HarborPage,
  navigateTo: (page: HarborPage, options?: { replace?: boolean }) => void,
) {
  if (page === "home") return <HarborHomePage navigateTo={navigateTo} />;
  if (page === "assessments") return <HarborInstructorAssessmentsPage navigateTo={navigateTo} />;
  if (page === "analytics") return <HarborInstructorAnalyticsPage navigateTo={navigateTo} />;
  if (page === "manual-scoring") return <HarborManualScoringPage />;
  if (page === "roster") return <HarborInstructorRosterPage navigateTo={navigateTo} />;
  if (page === "lms") return <HarborInstructorLmsPage />;
  if (page === "results-ops") return <HarborResultsOpsPage navigateTo={navigateTo} />;
  if (page === "launch") return <HarborLaunchPage navigateTo={navigateTo} />;
  if (page === "session") return <HarborSessionPage navigateTo={navigateTo} />;
  if (page === "history") return <HarborHistoryPage navigateTo={navigateTo} />;
  if (page === "login") return <HarborPasswordAuthPage mode="login" navigateTo={navigateTo} />;
  if (page === "forgot-password") {
    return <HarborPasswordAuthPage mode="forgot" navigateTo={navigateTo} />;
  }
  if (page === "reset-password") {
    return <HarborPasswordAuthPage mode="reset" navigateTo={navigateTo} />;
  }
  return <HarborDetailsPage navigateTo={navigateTo} />;
}
