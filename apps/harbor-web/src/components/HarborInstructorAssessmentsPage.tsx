import { assessmentManagementContext } from "@/lib/assessment-management-context";
import { computed, onMounted, reactive, ref, useSetup, watch } from "@/lib/preact-reactivity";
import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import type { CreateAssignmentRequest, UpdateAssignmentRequest } from "@harbor/attempt-protocol";

type AssignmentFormState = {
  assignmentId: string;
  assessmentId: string;
  assessmentVersionId: string;
  title: string;
  status: "draft" | "active" | "closed";
  availableFrom: string;
  availableUntil: string;
  reportingTimezone: string;
  maxAttempts: string;
  timeLimitSeconds: string;
  gracePeriodSeconds: string;
  navigationMode: "linear" | "free";
  standaloneAllowed: boolean;
  iframeAllowed: boolean;
  allowedEmbedOrigins: string;
  secureBrowserRequired: boolean;
  secureBrowserProviderHint: string;
  safeExamBrowserGeneratedConfig: boolean;
  safeExamBrowserConfigKeyHash: string;
  proctoringProvider: string;
  learnerTargets: string;
  sectionTargets: string;
};

export default function HarborInstructorAssessmentsPage(_props: {
  navigateTo: (page: HarborPage) => void;
}) {
  const {
    activateInstructorAssignment,
    closeInstructorAssignment,
    createInstructorAssignment,
    instructorActor,
    institutionalSession,
    instructorAssignmentError,
    instructorAssignments,
    instructorAssignmentsError,
    instructorAssignmentsLoading,
    instructorPublishedAssessmentVersions,
    instructorPublishedAssessmentVersionsError,
    instructorPublishedAssessmentVersionsLoading,
    instructorSections,
    instructorSectionsError,
    instructorSectionsLoading,
    instructorWorkspaceBusy,
    instructorWorkspaceStatus,
    refreshInstructorAssignments,
    refreshInstructorPublishedAssessmentVersions,
    refreshInstructorSections,
    selectedInstructorAssignment,
    selectedInstructorAssignmentId,
    selectInstructorAssignment,
    updateInstructorAssignment,
  } = useHarborRuntime();

  const state = useSetup(() => {
    const draftMode = ref<"create" | "edit">("create");
    const form = reactive<AssignmentFormState>(createEmptyForm());
    const editorOpen = ref(false);
    const requestedVersionId = new URL(window.location.href).searchParams.get(
      "assessmentVersionId",
    );
    const context = computed(() =>
      assessmentManagementContext(
        requestedVersionId,
        instructorPublishedAssessmentVersions.value,
        instructorAssignments.value,
      ),
    );
    const requestedVersion = computed(() => context.value.version);
    const selectedPublishedVersionId = ref(requestedVersionId ?? "");
    const showAllAssessments = ref(false);

    const sortedAssignments = computed(() =>
      [...context.value.assignments].sort(
        (left, right) =>
          assignmentStatusRank(left.status) - assignmentStatusRank(right.status) ||
          right.updatedAt.localeCompare(left.updatedAt),
      ),
    );

    const selectedSummary = computed(
      () =>
        context.value.assignments.find(
          (assignment) => assignment.assignmentId === selectedInstructorAssignmentId.value,
        ) ?? null,
    );

    const visibleAssignments = computed(() => {
      if (showAllAssessments.value || sortedAssignments.value.length <= 12) {
        return sortedAssignments.value;
      }

      const recentAssignments = sortedAssignments.value.slice(0, 12);
      const selectedAssignment = selectedSummary.value;
      if (
        !selectedAssignment ||
        recentAssignments.some(
          (assignment) => assignment.assignmentId === selectedAssignment.assignmentId,
        )
      ) {
        return recentAssignments;
      }

      return [selectedAssignment, ...recentAssignments];
    });

    const hiddenAssignmentCount = computed(() =>
      Math.max(sortedAssignments.value.length - visibleAssignments.value.length, 0),
    );

    const selectedPublishedVersion = computed(
      () =>
        instructorPublishedAssessmentVersions.value.find(
          (version) => version.assessmentVersionId === selectedPublishedVersionId.value,
        ) ?? null,
    );

    const canSaveAssignment = computed(() => {
      if (!form.title.trim()) return false;
      if (draftMode.value === "edit") return true;
      return selectedPublishedVersion.value !== null;
    });

    onMounted(() => {
      void refreshInstructorAssignments();
      void refreshInstructorPublishedAssessmentVersions();
      void refreshInstructorSections();
    });

    watch(
      () => [selectedInstructorAssignment.value, requestedVersion.value] as const,
      ([assignment]) => {
        if (
          !assignment ||
          (requestedVersionId && assignment.assessmentId !== requestedVersion.value?.assessmentId)
        )
          return;
        draftMode.value = "edit";
        editorOpen.value = true;
        Object.assign(form, {
          assignmentId: assignment.id,
          assessmentId: assignment.assessmentId,
          assessmentVersionId: assignment.assessmentVersionId,
          title: assignment.title,
          status: assignment.status,
          availableFrom: toDateTimeLocal(assignment.policySnapshot.availableFrom),
          availableUntil: toDateTimeLocal(assignment.policySnapshot.availableUntil),
          reportingTimezone: assignment.policySnapshot.reportingTimezone,
          maxAttempts: String(assignment.policySnapshot.maxAttempts),
          timeLimitSeconds:
            assignment.policySnapshot.timeLimitSeconds === null
              ? ""
              : String(assignment.policySnapshot.timeLimitSeconds),
          gracePeriodSeconds:
            assignment.policySnapshot.gracePeriodSeconds === null
              ? ""
              : String(assignment.policySnapshot.gracePeriodSeconds),
          navigationMode: assignment.policySnapshot.navigationMode,
          standaloneAllowed: assignment.policySnapshot.standaloneAllowed,
          iframeAllowed: assignment.policySnapshot.iframeAllowed,
          allowedEmbedOrigins: assignment.policySnapshot.allowedEmbedOrigins.join(", "),
          secureBrowserRequired: assignment.policySnapshot.secureBrowserRequired,
          secureBrowserProviderHint: assignment.policySnapshot.secureBrowserProviderHint ?? "",
          safeExamBrowserGeneratedConfig:
            assignment.policySnapshot.safeExamBrowser?.generatedConfig?.enabled === true,
          safeExamBrowserConfigKeyHash:
            assignment.policySnapshot.safeExamBrowser?.configKeyHash ?? "",
          proctoringProvider: assignment.policySnapshot.proctoringProvider ?? "",
          learnerTargets: assignment.targets
            .filter((target) => target.kind === "learner")
            .map((target) => target.learnerId)
            .join("\n"),
          sectionTargets: assignment.targets
            .filter((target) => target.kind === "section")
            .map((target) => target.sectionId)
            .join("\n"),
        });
        selectedPublishedVersionId.value = assignment.assessmentVersionId;
      },
      { immediate: true },
    );

    function startNewAssignment(): void {
      draftMode.value = "create";
      editorOpen.value = true;
      Object.assign(form, createEmptyForm());
      selectedPublishedVersionId.value = requestedVersionId ?? "";
      if (requestedVersion.value) form.title = requestedVersion.value.assessmentTitle;
    }

    function openAssignment(assignmentId: string): void {
      editorOpen.value = true;
      void selectInstructorAssignment(assignmentId);
    }

    function closeEditor(): void {
      editorOpen.value = false;
    }

    async function saveAssignment(): Promise<void> {
      syncSelectedPublishedVersionToForm();
      const request = buildAssignmentRequest(form);

      if (draftMode.value === "edit" && selectedInstructorAssignment.value) {
        await updateInstructorAssignment({
          assignmentId: selectedInstructorAssignment.value.id,
          request,
        });
        return;
      }

      await createInstructorAssignment({
        assignmentId: form.assignmentId.trim(),
        assessmentId: form.assessmentId.trim(),
        assessmentVersionId: form.assessmentVersionId.trim(),
        title: request.title,
        status: request.status,
        policySnapshot: request.policySnapshot,
        targets: request.targets,
        ltiLinkages: request.ltiLinkages,
      });
    }

    function syncSelectedPublishedVersionToForm(): void {
      const version = selectedPublishedVersion.value;
      if (!version) return;
      form.assessmentId = version.assessmentId;
      form.assessmentVersionId = version.assessmentVersionId;
    }

    return {
      requestedVersionId,
      requestedVersion,
      context,
      canSaveAssignment,
      closeEditor,
      draftMode,
      editorOpen,
      form,
      hiddenAssignmentCount,
      openAssignment,
      saveAssignment,
      selectedPublishedVersionId,
      selectedSummary,
      showAllAssessments,
      startNewAssignment,
      visibleAssignments,
    };
  });

  return (
    <section class="assessments-page">
      <section class="assessments-intro">
        <div>
          <h1>{state.requestedVersion.value?.assessmentTitle ?? "Delivery assignments"}</h1>
          {state.requestedVersionId && (
            <p>
              Delivery settings for this assessment.{" "}
              <a href="/assessments">View all delivery assignments</a>
            </p>
          )}
        </div>
        <div class="intro-actions">
          <button
            class="primary-action"
            type="button"
            data-testid="assessment-new-button"
            disabled={Boolean(state.requestedVersionId && !state.requestedVersion.value)}
            onClick={state.startNewAssignment}
          >
            Create assignment
          </button>
          <button
            class="secondary-action"
            type="button"
            disabled={instructorAssignmentsLoading.value}
            onClick={() => void refreshInstructorAssignments()}
          >
            Refresh
          </button>
        </div>
      </section>

      <details class="context-panel">
        <summary class="advanced-summary">
          <span class="advanced-summary-copy">
            <strong>Instructor context</strong>
            <span>{instructorActor.displayName || instructorActor.actorId}</span>
          </span>
          <span class="summary-pill">{instructorWorkspaceStatus.value}</span>
        </summary>

        <div class="advanced-panel-body">
          <div class="field-row">
            <label class="field">
              <span>Actor ID</span>
              <input
                value={instructorActor.actorId}
                data-testid="instructor-actor-id-input"
                autoComplete="off"
                placeholder="inst_local_demo"
                onInput={(event) => {
                  instructorActor.actorId = event.currentTarget.value;
                }}
              />
            </label>
            <label class="field">
              <span>Display Name</span>
              <input
                value={instructorActor.displayName}
                data-testid="instructor-actor-name-input"
                autoComplete="off"
                placeholder="Local Instructor"
                onInput={(event) => {
                  instructorActor.displayName = event.currentTarget.value;
                }}
              />
            </label>
          </div>

          <p class="status-copy">{instructorWorkspaceStatus.value}</p>
        </div>
      </details>

      <section class="workspace-grid">
        <article class="assessments-list-card">
          <header class="card-header">
            <h2>Delivery assignments</h2>
          </header>

          {instructorAssignmentsError.value ? (
            <section class="list-feedback list-feedback--error" role="alert">
              <strong>Unavailable</strong>
              <p>{instructorAssignmentsError.value}</p>
              {!institutionalSession.value && (
                <a class="button button--primary" href={managementSignInHref()}>
                  Sign in to manage delivery
                </a>
              )}
            </section>
          ) : instructorAssignmentsLoading.value ? (
            <section class="list-feedback">
              <strong>Loading</strong>
            </section>
          ) : state.visibleAssignments.value.length === 0 ? (
            <section class="list-feedback">
              <strong>No delivery assignments</strong>
              {state.requestedVersionId && (
                <p>
                  {instructorPublishedAssessmentVersionsLoading.value
                    ? "Loading published assessment…"
                    : state.requestedVersion.value
                      ? "Create a delivery assignment to choose learners, availability, and attempt settings."
                      : "This published assessment is unavailable in your workspace."}
                </p>
              )}
            </section>
          ) : (
            <>
              <section class="assessment-list" data-testid="instructor-assessment-list">
                {state.visibleAssignments.value.map((assignment) => (
                  <button
                    key={assignment.assignmentId}
                    class="assessment-list-item"
                    data-active={
                      state.editorOpen.value &&
                      state.draftMode.value === "edit" &&
                      selectedInstructorAssignmentId.value === assignment.assignmentId
                    }
                    data-testid={`assessment-card-${assignment.assignmentId}`}
                    type="button"
                    onClick={() => state.openAssignment(assignment.assignmentId)}
                  >
                    <div class="item-topline">
                      <strong>{assignment.title}</strong>
                      <span class="status-pill">{assignment.status}</span>
                    </div>
                    <p>
                      {formatWindow(assignment.availableFrom)} to{" "}
                      {formatWindow(assignment.availableUntil)}
                    </p>
                    <div class="item-meta">
                      <span>{formatLearnerCount(assignment.learnerTargetCount)}</span>
                      <span>{formatSectionCount(assignment.sectionTargetCount)}</span>
                    </div>
                  </button>
                ))}
              </section>

              {(state.hiddenAssignmentCount.value > 0 || state.showAllAssessments.value) && (
                <button
                  class="list-disclosure-button"
                  type="button"
                  onClick={() => {
                    state.showAllAssessments.value = !state.showAllAssessments.value;
                  }}
                >
                  {state.showAllAssessments.value
                    ? "Show recent only"
                    : `Show ${state.hiddenAssignmentCount.value} more`}
                </button>
              )}
            </>
          )}
        </article>

        {state.editorOpen.value && (
          <article class="editor-card">
            <header class="card-header">
              <div class="editor-title">
                <h2>
                  {state.draftMode.value === "edit"
                    ? (state.selectedSummary.value?.title ?? "Assignment settings")
                    : "Create assignment"}
                </h2>
                {state.draftMode.value === "edit" && state.selectedSummary.value && (
                  <span class="status-pill" data-testid="selected-assessment-status">
                    {state.selectedSummary.value.status}
                  </span>
                )}
              </div>

              <div class="card-actions">
                <button
                  class="primary-action"
                  type="button"
                  data-testid="assessment-save-button"
                  disabled={instructorWorkspaceBusy.value || !state.canSaveAssignment.value}
                  onClick={() => void state.saveAssignment()}
                >
                  {state.draftMode.value === "edit" ? "Save changes" : "Create assignment"}
                </button>
                {state.draftMode.value === "edit" && (
                  <>
                    <button
                      class="secondary-action"
                      type="button"
                      disabled={
                        !selectedInstructorAssignmentId.value || instructorWorkspaceBusy.value
                      }
                      data-testid="assessment-activate-button"
                      onClick={() => void activateInstructorAssignment()}
                    >
                      Activate
                    </button>
                    <button
                      class="secondary-action"
                      type="button"
                      disabled={
                        !selectedInstructorAssignmentId.value || instructorWorkspaceBusy.value
                      }
                      data-testid="assessment-close-button"
                      onClick={() => void closeInstructorAssignment()}
                    >
                      Close
                    </button>
                  </>
                )}
                <button
                  class="secondary-action"
                  type="button"
                  disabled={instructorWorkspaceBusy.value}
                  onClick={state.closeEditor}
                >
                  Done
                </button>
              </div>
            </header>

            {instructorAssignmentError.value && (
              <p class="list-feedback list-feedback--error" role="alert">
                {instructorAssignmentError.value}
              </p>
            )}

            <div class="editor-form">
              <section class="editor-section">
                <div class="section-heading">
                  <h3>Basics</h3>
                  {state.draftMode.value === "create" && (
                    <span class="section-note">
                      QFlowLearn Delivery keeps package IDs and versions behind the scenes.
                    </span>
                  )}
                </div>

                <div class="field-row">
                  <label class="field field--span-two">
                    <span>Title</span>
                    <input
                      value={state.form.title}
                      data-testid="assessment-title-input"
                      autoComplete="off"
                      placeholder="Biology Midterm"
                      onInput={(event) => {
                        state.form.title = event.currentTarget.value;
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Status</span>
                    <select
                      value={state.form.status}
                      data-testid="assessment-status-select"
                      onChange={(event) => {
                        state.form.status = event.currentTarget.value as
                          | "draft"
                          | "active"
                          | "closed";
                      }}
                    >
                      <option value="draft">Draft</option>
                      <option value="active">Active</option>
                      <option value="closed">Closed</option>
                    </select>
                  </label>
                </div>

                <div class="field-row">
                  <label class="field field--span-two">
                    <span>Assessment package</span>
                    <select
                      value={state.selectedPublishedVersionId.value}
                      data-testid="assessment-package-select"
                      disabled={instructorPublishedAssessmentVersionsLoading.value}
                      onChange={(event) => {
                        state.selectedPublishedVersionId.value = event.currentTarget.value;
                      }}
                    >
                      <option value="">
                        {instructorPublishedAssessmentVersionsLoading.value
                          ? "Loading packages"
                          : "Choose a published assessment"}
                      </option>
                      {state.context.value.versions.map((version) => (
                        <option
                          key={version.assessmentVersionId}
                          value={version.assessmentVersionId}
                        >
                          {version.assessmentTitle} · v{version.versionNumber}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                {instructorPublishedAssessmentVersionsError.value && (
                  <p class="list-feedback list-feedback--error" role="alert">
                    {instructorPublishedAssessmentVersionsError.value}
                  </p>
                )}
              </section>

              <details class="editor-section editor-section--collapsed">
                <summary class="advanced-summary">
                  <span class="advanced-summary-copy">
                    <strong>Scheduling and attempt rules</strong>
                    <span>
                      {state.form.maxAttempts || "1"} attempt
                      {state.form.maxAttempts === "1" ? "" : "s"} ·{" "}
                      {state.form.timeLimitSeconds || "no"} second limit
                    </span>
                  </span>
                </summary>

                <div class="field-row field-row--triple">
                  <label class="field">
                    <span>Available From</span>
                    <input
                      value={state.form.availableFrom}
                      type="datetime-local"
                      onInput={(event) => {
                        state.form.availableFrom = event.currentTarget.value;
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Available Until</span>
                    <input
                      value={state.form.availableUntil}
                      type="datetime-local"
                      onInput={(event) => {
                        state.form.availableUntil = event.currentTarget.value;
                      }}
                    />
                  </label>
                  <label class="field">
                    <span>Timezone</span>
                    <input
                      value={state.form.reportingTimezone}
                      autoComplete="off"
                      onInput={(event) => {
                        state.form.reportingTimezone = event.currentTarget.value;
                      }}
                    />
                  </label>
                </div>

                <div class="field-row field-row--quad">
                  <TextInput
                    label="Max Attempts"
                    value={state.form.maxAttempts}
                    inputMode="numeric"
                    onInput={(value) => {
                      state.form.maxAttempts = value;
                    }}
                  />
                  <TextInput
                    label="Time Limit Seconds"
                    value={state.form.timeLimitSeconds}
                    inputMode="numeric"
                    onInput={(value) => {
                      state.form.timeLimitSeconds = value;
                    }}
                  />
                  <TextInput
                    label="Grace Seconds"
                    value={state.form.gracePeriodSeconds}
                    inputMode="numeric"
                    onInput={(value) => {
                      state.form.gracePeriodSeconds = value;
                    }}
                  />
                  <label class="field">
                    <span>Navigation</span>
                    <select
                      value={state.form.navigationMode}
                      onChange={(event) => {
                        state.form.navigationMode = event.currentTarget.value as "linear" | "free";
                      }}
                    >
                      <option value="free">Free</option>
                      <option value="linear">Linear</option>
                    </select>
                  </label>
                </div>
              </details>

              <details class="editor-section editor-section--collapsed">
                <summary class="advanced-summary">
                  <span class="advanced-summary-copy">
                    <strong>Delivery controls</strong>
                    <span>
                      {state.form.standaloneAllowed ? "Standalone allowed" : "Standalone off"} ·{" "}
                      {state.form.iframeAllowed ? "iframe allowed" : "iframe off"}
                    </span>
                  </span>
                </summary>

                <div class="toggles">
                  <Checkbox
                    label="Allow standalone delivery"
                    checked={state.form.standaloneAllowed}
                    onChange={(value) => {
                      state.form.standaloneAllowed = value;
                    }}
                  />
                  <Checkbox
                    label="Allow iframe delivery"
                    checked={state.form.iframeAllowed}
                    onChange={(value) => {
                      state.form.iframeAllowed = value;
                    }}
                  />
                  <Checkbox
                    label="Require secure browser"
                    checked={state.form.secureBrowserRequired}
                    onChange={(value) => {
                      state.form.secureBrowserRequired = value;
                    }}
                  />
                </div>

                <div class="field-row">
                  <label class="field">
                    <span>Allowed Embed Origins</span>
                    <textarea
                      value={state.form.allowedEmbedOrigins}
                      rows={3}
                      placeholder="https://lms.example.edu"
                      onInput={(event) => {
                        state.form.allowedEmbedOrigins = event.currentTarget.value;
                      }}
                    />
                  </label>
                  <TextInput
                    label="Secure Browser Provider Hint"
                    value={state.form.secureBrowserProviderHint}
                    onInput={(value) => {
                      state.form.secureBrowserProviderHint = value;
                    }}
                  />
                  <TextInput
                    label="Proctoring Provider"
                    value={state.form.proctoringProvider}
                    onInput={(value) => {
                      state.form.proctoringProvider = value;
                    }}
                  />
                </div>

                <div class="field-row">
                  <Checkbox
                    label="Generate QFlowLearn Delivery SEB config"
                    checked={state.form.safeExamBrowserGeneratedConfig}
                    onChange={(value) => {
                      state.form.safeExamBrowserGeneratedConfig = value;
                    }}
                  />
                  <label class="field">
                    <span>SEB Config Key Hash</span>
                    <input
                      value={state.form.safeExamBrowserConfigKeyHash}
                      disabled={state.form.safeExamBrowserGeneratedConfig}
                      autoComplete="off"
                      spellcheck={false}
                      onInput={(event) => {
                        state.form.safeExamBrowserConfigKeyHash = event.currentTarget.value;
                      }}
                    />
                  </label>
                </div>
              </details>

              <section class="editor-section editor-section--collapsed">
                <div class="advanced-summary">
                  <span class="advanced-summary-copy">
                    <strong>Targets</strong>
                    <span>
                      {splitLinesOrCommas(state.form.learnerTargets).length} learner
                      {splitLinesOrCommas(state.form.learnerTargets).length === 1 ? "" : "s"} ·{" "}
                      {splitLinesOrCommas(state.form.sectionTargets).length} section
                      {splitLinesOrCommas(state.form.sectionTargets).length === 1 ? "" : "s"}
                    </span>
                  </span>
                </div>

                <div class="target-grid">
                  <section class="learner-target-picker">
                    <div class="target-picker-header">
                      <div>
                        <strong>Learner Targets</strong>
                        <p>{splitLinesOrCommas(state.form.learnerTargets).length} selected</p>
                      </div>
                    </div>
                    <label class="field">
                      <span>Learner IDs</span>
                      <textarea
                        value={state.form.learnerTargets}
                        data-testid="assessment-learner-targets-input"
                        rows={4}
                        placeholder="learner_123"
                        onInput={(event) => {
                          state.form.learnerTargets = event.currentTarget.value;
                        }}
                      />
                    </label>
                  </section>

                  <section class="section-target-picker">
                    <div class="target-picker-header">
                      <div>
                        <strong>Section Targets</strong>
                        <p>{splitLinesOrCommas(state.form.sectionTargets).length} selected</p>
                      </div>
                      <button
                        class="secondary-action section-refresh-button"
                        type="button"
                        disabled={instructorSectionsLoading.value}
                        onClick={() => void refreshInstructorSections()}
                      >
                        Refresh
                      </button>
                    </div>
                    {instructorSectionsError.value && (
                      <p class="target-picker-error" role="alert">
                        {instructorSectionsError.value}
                      </p>
                    )}
                    <section
                      class="section-option-list"
                      data-testid="assessment-section-option-list"
                    >
                      {instructorSections.value.slice(0, 10).map((section) => (
                        <button
                          key={section.id}
                          class="section-option-button"
                          data-selected={splitLinesOrCommas(state.form.sectionTargets).includes(
                            section.id,
                          )}
                          data-testid={`assessment-section-option-${section.id}`}
                          type="button"
                          onClick={() => {
                            const current = new Set(splitLinesOrCommas(state.form.sectionTargets));
                            if (current.has(section.id)) current.delete(section.id);
                            else current.add(section.id);
                            state.form.sectionTargets = [...current].join("\n");
                          }}
                        >
                          <span>
                            <strong>{section.title}</strong>
                            <small>
                              {[section.sourceId, section.sourceKind].filter(Boolean).join(" · ")}
                            </small>
                          </span>
                          <span>{formatSectionLearnerCount(section.activeLearnerCount)}</span>
                        </button>
                      ))}
                    </section>
                    <label class="field">
                      <span>Section IDs</span>
                      <textarea
                        value={state.form.sectionTargets}
                        rows={4}
                        data-testid="assessment-section-targets-input"
                        placeholder="section_bio_101"
                        onInput={(event) => {
                          state.form.sectionTargets = event.currentTarget.value;
                        }}
                      />
                    </label>
                  </section>
                </div>
              </section>
            </div>
          </article>
        )}
      </section>
    </section>
  );
}

function TextInput(props: {
  label: string;
  value: string;
  inputMode?: "numeric";
  onInput: (value: string) => void;
}) {
  return (
    <label class="field">
      <span>{props.label}</span>
      <input
        value={props.value}
        inputMode={props.inputMode}
        autoComplete="off"
        onInput={(event) => props.onInput(event.currentTarget.value)}
      />
    </label>
  );
}

function Checkbox(props: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label class="toggle">
      <input
        checked={props.checked}
        type="checkbox"
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span>{props.label}</span>
    </label>
  );
}

function createEmptyForm(): AssignmentFormState {
  const seed = Date.now().toString(36);
  return {
    assignmentId: `assign_harbor_${seed}`,
    assessmentId: "",
    assessmentVersionId: "",
    title: "",
    status: "draft",
    availableFrom: "",
    availableUntil: "",
    reportingTimezone: "America/New_York",
    maxAttempts: "1",
    timeLimitSeconds: "1800",
    gracePeriodSeconds: "30",
    navigationMode: "free",
    standaloneAllowed: true,
    iframeAllowed: false,
    allowedEmbedOrigins: "",
    secureBrowserRequired: false,
    secureBrowserProviderHint: "",
    safeExamBrowserGeneratedConfig: false,
    safeExamBrowserConfigKeyHash: "",
    proctoringProvider: "",
    learnerTargets: "",
    sectionTargets: "",
  };
}

function buildAssignmentRequest(form: AssignmentFormState): Omit<UpdateAssignmentRequest, "actor"> {
  return {
    title: form.title.trim(),
    status: form.status,
    policySnapshot: {
      availableFrom: toIsoStringOrNull(form.availableFrom),
      availableUntil: toIsoStringOrNull(form.availableUntil),
      reportingTimezone: form.reportingTimezone.trim() || "America/New_York",
      maxAttempts: normalizeInteger(form.maxAttempts, 1),
      timeLimitSeconds: normalizeNullableInteger(form.timeLimitSeconds),
      gracePeriodSeconds: normalizeNullableInteger(form.gracePeriodSeconds),
      navigationMode: form.navigationMode,
      standaloneAllowed: form.standaloneAllowed,
      iframeAllowed: form.iframeAllowed,
      allowedEmbedOrigins: splitLinesOrCommas(form.allowedEmbedOrigins),
      secureBrowserRequired: form.secureBrowserRequired,
      secureBrowserProviderHint: normalizeOptionalString(form.secureBrowserProviderHint),
      safeExamBrowser: buildSafeExamBrowserPolicy(form),
      proctoringProvider: normalizeOptionalString(form.proctoringProvider),
    },
    targets: [
      ...splitLinesOrCommas(form.learnerTargets).map((learnerId) => ({
        kind: "learner" as const,
        learnerId,
      })),
      ...splitLinesOrCommas(form.sectionTargets).map((sectionId) => ({
        kind: "section" as const,
        sectionId,
      })),
    ],
    ltiLinkages: [],
  };
}

function buildSafeExamBrowserPolicy(
  form: AssignmentFormState,
): CreateAssignmentRequest["policySnapshot"]["safeExamBrowser"] {
  const generatedConfig = form.safeExamBrowserGeneratedConfig ? { enabled: true } : null;
  const configKeyHash = normalizeOptionalString(form.safeExamBrowserConfigKeyHash);

  if (!generatedConfig && !configKeyHash) return null;

  return {
    generatedConfig,
    verificationMode: "config-key",
    configKeyHash: generatedConfig ? null : configKeyHash,
    browserExamKeys: [],
  };
}

function splitLinesOrCommas(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function normalizeOptionalString(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeNullableInteger(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function toDateTimeLocal(value: string | null): string {
  if (!value) return "";
  return value.slice(0, 16);
}

function toIsoStringOrNull(value: string): string | null {
  return value.trim() ? new Date(value).toISOString() : null;
}

function formatWindow(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Open";
}

function formatLearnerCount(value: number): string {
  return value === 1 ? "1 learner" : `${value} learners`;
}

function formatSectionCount(value: number): string {
  return value === 1 ? "1 section" : `${value} sections`;
}

function formatSectionLearnerCount(value: number): string {
  return value === 1 ? "1 learner" : `${value} learners`;
}

function assignmentStatusRank(status: string): number {
  if (status === "active") return 0;
  if (status === "draft") return 1;
  return 2;
}

function managementSignInHref(): string {
  const url = new URL(window.location.href);
  url.pathname = "/login";
  url.searchParams.set("returnTo", "assessments");
  return `${url.pathname}${url.search}`;
}
