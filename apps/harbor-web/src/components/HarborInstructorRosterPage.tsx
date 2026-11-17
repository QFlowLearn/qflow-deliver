import StagedAssessmentSummary from "./session/StagedAssessmentSummary";
import {
  HARBOR_QTI3_COLOR_THEMES,
  SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME,
  type HarborQti3ColorTheme,
  type AssignmentLearnerOverrideRecord,
} from "@harbor/attempt-protocol";
import { computed, onMounted, reactive, ref, useSetup, watch } from "@/lib/preact-reactivity";
import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import { formatError } from "@/lib/harbor-runtime/formatting";
import {
  OverrideInput,
  ProfileCheckbox,
  ProfileSupportModeControl,
  buildActionId,
  buildProfilePnpEntitlement,
  formatDuration,
  formatPercent,
  formatResultStatus,
  formatScore,
  formatTimestamp,
  isLegacyShellMode,
  normalizeOptionalInteger,
  type ProfileSupportMode,
} from "@/components/instructor-roster/roster-page-helpers";

type OverrideFormState = {
  additionalTimeSeconds: string;
  maxAttempts: string;
  timeLimitSeconds: string;
  gracePeriodSeconds: string;
  singleColumn: boolean;
};

export default function HarborInstructorRosterPage(props: {
  navigateTo: (page: HarborPage) => void;
}) {
  const {
    instructorAssignmentCapabilities,
    accommodationProfiles,
    accommodationProfilesError,
    accommodationProfilesLoading,
    applyInstructorAttemptAction,
    createAccommodationProfile,
    instructorAttemptEvidence,
    instructorAttemptEvidenceError,
    instructorAttemptEvidenceLoading,
    instructorAttemptTimeline,
    instructorAttemptTimelineError,
    instructorAttemptTimelineLoading,
    instructorAssignmentReport,
    instructorResults,
    instructorLearnerReport,
    instructorRosterError,
    instructorRosterLoading,
    instructorRosterRows,
    instructorWorkspaceBusy,
    learnerAccommodationAssignments,
    learnerAccommodationAssignmentsLoading,
    openAttemptHistory,
    refreshAccommodationProfiles,
    refreshInstructorAttemptTimeline,
    refreshInstructorLearnerReport,
    refreshInstructorWorkspace,
    refreshLearnerAccommodationAssignments,
    saveAssignmentLearnerOverride,
    saveLearnerAccommodationProfile,
    selectedInstructorAssignmentId,
    selectedInstructorAssignmentTitle,
  } = useHarborRuntime();

  const state = useSetup(() => {
    const replacementWorkstationCode = ref("");
    const transferReason = ref("");
    const incidentReason = ref("");
    const incidentMinutes = ref("5");
    const selectedLearnerId = ref("");
    const selectedAccommodationProfileId = ref("");
    const createAndAssignProfile = ref(true);
    const overrideForm = reactive<OverrideFormState>({
      additionalTimeSeconds: "",
      maxAttempts: "",
      timeLimitSeconds: "",
      gracePeriodSeconds: "",
      singleColumn: false,
    });
    let overrideDraft: {
      readonly assignmentId: string;
      readonly learnerId: string;
      editRevision: number;
      confirmedRevision: number;
    } | null = null;
    const profileForm = reactive({
      name: "",
      colorStyle: "qti3-player-color-default" as HarborQti3ColorTheme,
      singleColumn: false,
      textToSpeech: false,
      lineReader: false,
      answerMasking: false,
      calculator: "none" as "none" | "basic" | "scientific",
      notepad: false,
      captions: false,
      transcripts: false,
      transcriptMode: "off" as ProfileSupportMode,
      captionMode: "off" as ProfileSupportMode,
      audioDescriptionMode: "off" as ProfileSupportMode,
      signLanguageMode: "off" as ProfileSupportMode,
      pnpLanguages: "",
    });

    const selectedLearnerRow = computed(
      () =>
        instructorRosterRows.value.find((row) => row.learner.id === selectedLearnerId.value) ??
        instructorRosterRows.value[0] ??
        null,
    );

    const activeAccommodationProfiles = computed(() =>
      accommodationProfiles.value.filter((profile) => profile.status === "active"),
    );

    const activeAccommodationAssignmentIds = computed(
      () =>
        new Set(
          learnerAccommodationAssignments.value
            .filter((assignment) => assignment.status === "active")
            .map((assignment) => assignment.profileId),
        ),
    );

    const activeAccommodationSummary = computed(() => {
      const names = learnerAccommodationAssignments.value
        .filter((assignment) => assignment.status === "active")
        .map((assignment) => assignment.profileName);
      return names.length > 0 ? names.join(", ") : "No active profile";
    });

    const resultSummary = computed(() => {
      if (!instructorResults.value) {
        return {
          targetedLearnerCount: 0,
          notStartedCount: 0,
          inProgressCount: 0,
          pendingCount: 0,
          completeCount: 0,
          failedCount: 0,
          rescoredCount: 0,
        };
      }

      return instructorResults.value.summary;
    });

    const reportingSummary = computed(() => instructorAssignmentReport.value?.summary ?? null);

    const selectedAttemptId = computed(() => {
      if (!selectedLearnerRow.value) return null;
      return selectedLearnerRow.value.latestAttempt.status === "not-started"
        ? null
        : selectedLearnerRow.value.latestAttempt.attemptId;
    });

    watch(
      () => selectedAttemptId.value,
      () => {
        incidentReason.value = "";
      },
    );

    const attemptEvidenceEvents = computed(() => instructorAttemptEvidence.value?.events ?? []);

    const visibleAttemptEvidenceEvents = computed(() =>
      attemptEvidenceEvents.value.slice(-8).reverse(),
    );

    const attemptEvidenceSummary = computed(() => {
      const events = attemptEvidenceEvents.value;
      return {
        itemPresentationCount: events.filter((event) => event.evidenceKind === "item-presentation")
          .length,
        responseCount: events.filter((event) => event.evidenceKind === "response").length,
        submitCount: events.filter((event) => event.evidenceKind === "submit").length,
        flaggedCount: events.filter(
          (event) =>
            event.outcome !== "accepted" &&
            event.outcome !== SERVER_PROJECTED_ATTEMPT_EVIDENCE_OUTCOME,
        ).length,
      };
    });

    const attemptAccommodationSnapshotSummary = computed(() => {
      const snapshot = instructorAttemptTimeline.value?.accommodationSnapshot;
      if (!snapshot) return "No snapshot yet";

      const parts = [
        `${snapshot.profileIds.length} profile${snapshot.profileIds.length === 1 ? "" : "s"}`,
        `${snapshot.learnerProfileAssignmentIds.length} assignment${snapshot.learnerProfileAssignmentIds.length === 1 ? "" : "s"}`,
      ];
      if (snapshot.assignmentOverrideId) parts.push("override");
      if (snapshot.summary.extraTimeSeconds > 0) {
        parts.push(`${formatDuration(snapshot.summary.extraTimeSeconds)} extra time`);
      }
      if (snapshot.summary.shellTools.length > 0) {
        parts.push(
          `${snapshot.summary.shellTools.length} shell tool${snapshot.summary.shellTools.length === 1 ? "" : "s"}`,
        );
      }
      return parts.join(" · ");
    });

    onMounted(async () => {
      if (selectedInstructorAssignmentId.value) {
        await refreshInstructorWorkspace();
      }
      try {
        await refreshAccommodationProfiles();
      } catch (error: unknown) {
        accommodationProfilesError.value = formatError(error);
      }
    });

    watch(
      () => instructorRosterRows.value,
      (rows) => {
        if (rows.length === 0) {
          selectedLearnerId.value = "";
          return;
        }

        if (
          !rows.some(
            (row: { learner: { id: string } }) => row.learner.id === selectedLearnerId.value,
          )
        ) {
          selectedLearnerId.value = rows[0].learner.id;
        }
      },
      { immediate: true },
    );

    watch(
      [selectedInstructorAssignmentId, selectedLearnerRow] as const,
      async ([assignmentId, row]) => {
        if (overrideDraft?.assignmentId !== assignmentId) {
          overrideDraft = null;
          resetOverrideForm();
        }
        if (!row) {
          await refreshInstructorAttemptTimeline(undefined);
          await refreshInstructorLearnerReport();
          return;
        }

        if (!overrideDraft || overrideDraft.learnerId !== row.learner.id) {
          overrideDraft = {
            assignmentId,
            learnerId: row.learner.id,
            editRevision: 0,
            confirmedRevision: 0,
          };
        }
        // Roster refreshes update clean forms, never an instructor's unsaved draft.
        if (overrideDraft.editRevision === overrideDraft.confirmedRevision)
          restoreOverrideForm(row.activeOverride);

        const attemptId =
          row.latestAttempt.status === "not-started" ? null : row.latestAttempt.attemptId;
        await refreshLearnerAccommodationAssignments(row.learner.id);
        selectFirstAssignableAccommodationProfile();
        await refreshInstructorLearnerReport({
          assignmentId: selectedInstructorAssignmentId.value,
          learnerId: row.learner.id,
        });
        await refreshInstructorAttemptTimeline(attemptId ?? undefined);
      },
      { immediate: true },
    );

    watch(
      () => activeAccommodationProfiles.value,
      () => {
        if (!selectedAccommodationProfileId.value) selectFirstAssignableAccommodationProfile();
      },
    );

    function selectFirstAssignableAccommodationProfile(): void {
      const firstAssignableProfile = activeAccommodationProfiles.value.find(
        (profile) => !activeAccommodationAssignmentIds.value.has(profile.id),
      );
      selectedAccommodationProfileId.value = firstAssignableProfile?.id ?? "";
    }

    function updateOverrideField<Key extends keyof OverrideFormState>(
      key: Key,
      value: OverrideFormState[Key],
    ): void {
      if (!overrideDraft) return;
      overrideDraft.editRevision++;
      overrideForm[key] = value;
    }

    function restoreOverrideForm(override: AssignmentLearnerOverrideRecord | null): void {
      overrideForm.additionalTimeSeconds =
        override?.policyOverrides.additionalTimeSeconds?.toString() ?? "";
      overrideForm.maxAttempts = override?.policyOverrides.maxAttempts?.toString() ?? "";
      overrideForm.timeLimitSeconds = override?.policyOverrides.timeLimitSeconds?.toString() ?? "";
      overrideForm.gracePeriodSeconds =
        override?.policyOverrides.gracePeriodSeconds?.toString() ?? "";
      overrideForm.singleColumn = override?.accommodations.rendererPnp.layoutSingleColumn ?? false;
    }

    async function saveOverride(): Promise<void> {
      const draft = overrideDraft;
      if (
        !draft ||
        draft.assignmentId !== selectedInstructorAssignmentId.value ||
        draft.learnerId !== selectedLearnerRow.value?.learner.id
      )
        return;
      const revision = draft.editRevision;
      try {
        const saved = await saveAssignmentLearnerOverride({
          assignmentId: draft.assignmentId,
          learnerId: draft.learnerId,
          policyOverrides: {
            additionalTimeSeconds: normalizeOptionalInteger(overrideForm.additionalTimeSeconds),
            maxAttempts: normalizeOptionalInteger(overrideForm.maxAttempts),
            timeLimitSeconds: normalizeOptionalInteger(overrideForm.timeLimitSeconds),
            gracePeriodSeconds: normalizeOptionalInteger(overrideForm.gracePeriodSeconds),
          },
          accommodations: {
            rendererPnp: { layoutSingleColumn: overrideForm.singleColumn },
            sessionControl: {},
          },
        });
        if (overrideDraft !== draft) return;
        draft.confirmedRevision = revision;
        if (draft.editRevision === revision) restoreOverrideForm(saved);
      } catch {
        // The request owner displays the error. Keep the same draft available for retry.
      }
    }

    function resetOverrideForm(): void {
      overrideForm.additionalTimeSeconds = "";
      overrideForm.maxAttempts = "";
      overrideForm.timeLimitSeconds = "";
      overrideForm.gracePeriodSeconds = "";
      overrideForm.singleColumn = false;
    }

    return {
      replacementWorkstationCode,
      transferReason,
      incidentReason,
      incidentMinutes,
      activeAccommodationAssignmentIds,
      activeAccommodationProfiles,
      activeAccommodationSummary,
      attemptAccommodationSnapshotSummary,
      attemptEvidenceSummary,
      createAndAssignProfile,
      overrideForm,
      updateOverrideField,
      saveOverride,
      profileForm,
      reportingSummary,
      resultSummary,
      selectedAccommodationProfileId,
      selectedAttemptId,
      selectedLearnerId,
      selectedLearnerRow,
      visibleAttemptEvidenceEvents,
    };
  });

  async function transferToReplacementWorkstation(): Promise<void> {
    if (
      !state.selectedAttemptId.value ||
      !state.replacementWorkstationCode.value.trim() ||
      !state.transferReason.value.trim()
    )
      return;
    try {
      await applyInstructorAttemptAction({
        attemptId: state.selectedAttemptId.value,
        action: {
          actionId: buildActionId("transfer"),
          type: "transfer-workstation",
          effectiveAt: new Date().toISOString(),
          clientSessionId: state.replacementWorkstationCode.value.trim(),
          reason: state.transferReason.value.trim(),
        },
      });
      state.replacementWorkstationCode.value = "";
      state.transferReason.value = "";
    } catch (error: unknown) {
      instructorRosterError.value = formatError(error);
    }
  }

  async function assignAccommodationProfile(): Promise<void> {
    const row = state.selectedLearnerRow.value;
    if (!row || !state.selectedAccommodationProfileId.value) return;

    await saveLearnerAccommodationProfile({
      learnerId: row.learner.id,
      profileId: state.selectedAccommodationProfileId.value,
      status: "active",
    });
  }

  async function createProfile(): Promise<void> {
    const row = state.selectedLearnerRow.value;
    if (!row || !state.profileForm.name.trim()) return;

    const pnpEntitlement = buildProfilePnpEntitlement({
      transcript: state.profileForm.transcriptMode,
      caption: state.profileForm.captionMode,
      "audio-description": state.profileForm.audioDescriptionMode,
      "sign-language": state.profileForm.signLanguageMode,
      languages: state.profileForm.pnpLanguages,
    });
    const transcriptsCompat = isLegacyShellMode(state.profileForm.transcriptMode);
    const captionsCompat = isLegacyShellMode(state.profileForm.captionMode);

    const profile = await createAccommodationProfile({
      tenantId: row.learner.tenantId,
      name: state.profileForm.name.trim(),
      profile: {
        rendererPnp: {
          textAppearance: {
            colorStyle: state.profileForm.colorStyle,
          },
          layoutSingleColumn: state.profileForm.singleColumn,
        },
        shellTools: {
          textToSpeech: state.profileForm.textToSpeech,
          lineReader: state.profileForm.lineReader,
          answerMasking: state.profileForm.answerMasking,
          calculator: state.profileForm.calculator,
          notepad: state.profileForm.notepad,
          captions: state.profileForm.captions || captionsCompat,
          transcripts: state.profileForm.transcripts || transcriptsCompat,
        },
        ...(pnpEntitlement ? { pnpEntitlement } : {}),
      },
    });

    if (state.createAndAssignProfile.value) {
      await saveLearnerAccommodationProfile({
        learnerId: row.learner.id,
        profileId: profile.id,
        status: "active",
      });
    }

    state.profileForm.name = "";
    state.profileForm.colorStyle = "qti3-player-color-default";
    state.profileForm.singleColumn = false;
    state.profileForm.textToSpeech = false;
    state.profileForm.lineReader = false;
    state.profileForm.answerMasking = false;
    state.profileForm.calculator = "none";
    state.profileForm.notepad = false;
    state.profileForm.captions = false;
    state.profileForm.transcripts = false;
    state.profileForm.transcriptMode = "off";
    state.profileForm.captionMode = "off";
    state.profileForm.audioDescriptionMode = "off";
    state.profileForm.signLanguageMode = "off";
    state.profileForm.pnpLanguages = "";
  }

  async function applyTimingAction(type: "extend-time" | "reopen-attempt"): Promise<void> {
    if (!state.selectedAttemptId.value) return;
    const reason = state.incidentReason.value.trim();
    const minutes = Number(state.incidentMinutes.value);
    const reopenUntil = new Date(Date.now() + minutes * 60_000);
    if (
      !reason ||
      !Number.isSafeInteger(minutes) ||
      minutes < 1 ||
      !Number.isSafeInteger(minutes * 60) ||
      Number.isNaN(reopenUntil.getTime())
    ) {
      instructorRosterError.value =
        "Enter an incident reason and a positive whole number of minutes.";
      return;
    }
    const base = { actionId: buildActionId(type), reason, effectiveAt: new Date().toISOString() };
    try {
      await applyInstructorAttemptAction({
        attemptId: state.selectedAttemptId.value,
        action:
          type === "extend-time"
            ? { ...base, type, additionalTimeSeconds: minutes * 60 }
            : { ...base, type, reopenUntil: reopenUntil.toISOString() },
      });
      state.incidentReason.value = "";
    } catch (error: unknown) {
      instructorRosterError.value = formatError(error);
    }
  }

  async function openHistory(): Promise<void> {
    if (!state.selectedAttemptId.value) return;
    await openAttemptHistory(state.selectedAttemptId.value);
    props.navigateTo("history");
  }

  return (
    <section class="roster-page" data-testid="instructor-roster-page">
      <section class="roster-intro">
        <div>
          <h1>Roster</h1>
          <p class="meta-line">{selectedInstructorAssignmentTitle.value}</p>
        </div>
      </section>

      <section class="results-summary" data-testid="instructor-results-summary">
        <span class="summary-pill">
          <strong>{state.resultSummary.value.targetedLearnerCount}</strong> learners
        </span>
        <span class="summary-pill">
          <strong>{state.resultSummary.value.notStartedCount}</strong> not started
        </span>
        <span class="summary-pill">
          <strong>{state.resultSummary.value.inProgressCount}</strong> in progress
        </span>
        <span class="summary-pill">
          <strong data-testid="results-complete-count">
            {state.resultSummary.value.completeCount}
          </strong>{" "}
          complete
        </span>
        <span class="summary-pill">
          <strong>{state.resultSummary.value.pendingCount}</strong> pending
        </span>
        <span class="summary-pill">
          <strong>{state.resultSummary.value.failedCount}</strong> failed
        </span>
      </section>

      <details class="reporting-panel" data-testid="assessment-reporting-panel">
        <summary class="advanced-summary">
          <span class="advanced-summary-copy">
            <strong>Class analytics</strong>
            <span>Completion, score distribution, item performance, and standards mastery.</span>
          </span>
          <span class="summary-pill">
            <strong>{formatPercent(state.reportingSummary.value?.averagePercent ?? null)}</strong>{" "}
            avg
          </span>
        </summary>
      </details>

      <section class="workspace-grid">
        <article class="roster-list-card">
          <header class="card-header">
            <h2>Learners</h2>
            <button
              class="secondary-action"
              type="button"
              disabled={instructorRosterLoading.value}
              onClick={() => void refreshInstructorWorkspace()}
            >
              Refresh
            </button>
          </header>

          {instructorRosterError.value ? (
            <section class="feedback feedback--error" role="alert">
              <strong>Unavailable</strong>
              <p>{instructorRosterError.value}</p>
            </section>
          ) : instructorRosterLoading.value ? (
            <section class="feedback">
              <strong>Loading</strong>
            </section>
          ) : instructorRosterRows.value.length === 0 ? (
            <section class="feedback">
              <strong>No learners</strong>
            </section>
          ) : (
            <section class="roster-list" data-testid="instructor-roster-list">
              {instructorRosterRows.value.map((row) => (
                <button
                  key={row.learner.id}
                  class="roster-row"
                  data-active={state.selectedLearnerId.value === row.learner.id}
                  data-testid={`roster-row-${row.learner.id}`}
                  type="button"
                  onClick={() => {
                    state.selectedLearnerId.value = row.learner.id;
                  }}
                >
                  <div class="row-header">
                    <strong>{row.learner.displayName}</strong>
                    <span class="status-pill">{row.latestAttempt.status}</span>
                  </div>
                  <p class="row-subline">{row.learner.email || row.learner.id}</p>
                  <p class="row-meta">
                    <span>
                      {formatScore(
                        row.latestScore?.totalScore ?? null,
                        row.latestScore?.maxScore ?? null,
                      )}
                    </span>
                    <span>{formatResultStatus(row.latestResultStatus)}</span>
                    <span>
                      {row.attemptCount} attempt{row.attemptCount === 1 ? "" : "s"}
                    </span>
                  </p>
                </button>
              ))}
            </section>
          )}
        </article>

        {state.selectedLearnerRow.value && (
          <article class="detail-card">
            <header class="card-header">
              <div>
                <h2 data-testid="selected-roster-learner">
                  {state.selectedLearnerRow.value.learner.displayName}
                </h2>
                <p class="meta-line">
                  {state.selectedLearnerRow.value.learner.email ||
                    state.selectedLearnerRow.value.learner.id}
                </p>
              </div>
              <button
                class="secondary-action"
                type="button"
                disabled={!state.selectedAttemptId.value}
                data-testid="open-attempt-history-button"
                onClick={() => void openHistory()}
              >
                View history
              </button>
            </header>

            <section class="detail-summary">
              <span class="summary-pill">
                {state.selectedLearnerRow.value.latestAttempt.status}
              </span>
              <span class="summary-pill">
                {formatScore(
                  state.selectedLearnerRow.value.latestScore?.totalScore ?? null,
                  state.selectedLearnerRow.value.latestScore?.maxScore ?? null,
                )}
              </span>
              <span class="summary-pill">
                {formatResultStatus(state.selectedLearnerRow.value.latestResultStatus)}
              </span>
              <span class="summary-pill">
                {state.selectedLearnerRow.value.remainingAttempts} remaining
              </span>
            </section>

            {instructorLearnerReport.value?.learner.id ===
              state.selectedLearnerRow.value.learner.id &&
              instructorLearnerReport.value.stagedAssessment && (
                <StagedAssessmentSummary summary={instructorLearnerReport.value.stagedAssessment} />
              )}
            <p class="detail-copy">
              Started {formatTimestamp(state.selectedLearnerRow.value.latestAttempt.launchedAt)} ·
              Submitted {formatTimestamp(state.selectedLearnerRow.value.latestAttempt.submittedAt)}
            </p>

            {state.selectedAttemptId.value && (
              <p class="detail-copy" data-testid="last-server-response-save">
                Last server-confirmed response:{" "}
                {formatTimestamp(
                  instructorAttemptTimeline.value?.recovery?.lastConfirmedSaveAt ?? null,
                )}
              </p>
            )}
            {state.selectedAttemptId.value &&
              instructorAssignmentCapabilities.value?.canOperateExam && (
                <form
                  class="detail-section"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void transferToReplacementWorkstation();
                  }}
                >
                  <div class="field-grid">
                    <label class="field">
                      <span>Replacement workstation code</span>
                      <input
                        required
                        value={state.replacementWorkstationCode.value}
                        onInput={(event) => {
                          state.replacementWorkstationCode.value = event.currentTarget.value;
                        }}
                      />
                    </label>
                    <label class="field">
                      <span>Transfer reason</span>
                      <input
                        required
                        value={state.transferReason.value}
                        onInput={(event) => {
                          state.transferReason.value = event.currentTarget.value;
                        }}
                      />
                    </label>
                  </div>
                  <button
                    class="secondary-action"
                    type="submit"
                    disabled={
                      instructorWorkspaceBusy.value ||
                      !state.replacementWorkstationCode.value.trim() ||
                      !state.transferReason.value.trim()
                    }
                  >
                    Transfer workstation
                  </button>
                </form>
              )}

            <details class="advanced-learner-panel" data-testid="learner-advanced-panel" open>
              <summary class="advanced-summary">
                <span class="advanced-summary-copy">
                  <strong>Advanced learner controls</strong>
                  <span>Overrides, accommodations, active-attempt actions, and evidence.</span>
                </span>
              </summary>

              <section class="detail-grid">
                <article class="detail-section">
                  <div class="section-header">
                    <h3>Next attempt overrides</h3>
                    <button
                      class="primary-action"
                      type="button"
                      data-testid="save-learner-override-button"
                      disabled={instructorWorkspaceBusy.value}
                      onClick={() => void state.saveOverride()}
                    >
                      Save Override
                    </button>
                  </div>

                  <div class="field-grid">
                    <label class="field">
                      <span>Extra time seconds</span>
                      <input
                        value={state.overrideForm.additionalTimeSeconds}
                        data-testid="override-additional-time-input"
                        inputMode="numeric"
                        onInput={(event) => {
                          state.updateOverrideField(
                            "additionalTimeSeconds",
                            event.currentTarget.value,
                          );
                        }}
                      />
                    </label>
                    <OverrideInput
                      label="Max Attempts"
                      value={state.overrideForm.maxAttempts}
                      onInput={(value) => {
                        state.updateOverrideField("maxAttempts", value);
                      }}
                    />
                    <OverrideInput
                      label="Time limit"
                      value={state.overrideForm.timeLimitSeconds}
                      onInput={(value) => {
                        state.updateOverrideField("timeLimitSeconds", value);
                      }}
                    />
                    <OverrideInput
                      label="Grace period"
                      value={state.overrideForm.gracePeriodSeconds}
                      onInput={(value) => {
                        state.updateOverrideField("gracePeriodSeconds", value);
                      }}
                    />
                  </div>

                  <label class="toggle">
                    <input
                      checked={state.overrideForm.singleColumn}
                      type="checkbox"
                      onChange={(event) => {
                        state.updateOverrideField("singleColumn", event.currentTarget.checked);
                      }}
                    />
                    <span>Single-column layout</span>
                  </label>

                  <div class="accommodation-profile-box">
                    <div class="section-header">
                      <h3>Accommodation profile</h3>
                      <button
                        class="secondary-action"
                        type="button"
                        data-testid="assign-accommodation-profile-button"
                        disabled={
                          instructorWorkspaceBusy.value ||
                          accommodationProfilesLoading.value ||
                          learnerAccommodationAssignmentsLoading.value ||
                          !state.selectedAccommodationProfileId.value
                        }
                        onClick={() => void assignAccommodationProfile()}
                      >
                        Assign
                      </button>
                    </div>
                    <p class="detail-copy">{state.activeAccommodationSummary.value}</p>
                    <label class="field profile-select-field">
                      <span>Profile</span>
                      <select
                        value={state.selectedAccommodationProfileId.value}
                        data-testid="accommodation-profile-select"
                        disabled={
                          accommodationProfilesLoading.value ||
                          learnerAccommodationAssignmentsLoading.value
                        }
                        onChange={(event) => {
                          state.selectedAccommodationProfileId.value = event.currentTarget.value;
                        }}
                      >
                        <option value="">Select profile</option>
                        {state.activeAccommodationProfiles.value.map((profile) => (
                          <option
                            key={profile.id}
                            value={profile.id}
                            disabled={state.activeAccommodationAssignmentIds.value.has(profile.id)}
                          >
                            {profile.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {accommodationProfilesError.value && (
                      <p class="detail-copy detail-copy--error">
                        {accommodationProfilesError.value}
                      </p>
                    )}

                    <details class="profile-create-panel">
                      <summary>Create profile</summary>
                      <label class="field profile-select-field">
                        <span>Name</span>
                        <input
                          value={state.profileForm.name}
                          data-testid="profile-name-input"
                          autoComplete="off"
                          onInput={(event) => {
                            state.profileForm.name = event.currentTarget.value;
                          }}
                        />
                      </label>
                      <label class="field profile-select-field">
                        <span>Theme</span>
                        <select
                          value={state.profileForm.colorStyle}
                          data-testid="profile-theme-select"
                          onChange={(event) => {
                            state.profileForm.colorStyle = event.currentTarget
                              .value as HarborQti3ColorTheme;
                          }}
                        >
                          {HARBOR_QTI3_COLOR_THEMES.map((theme) => (
                            <option key={theme} value={theme}>
                              {theme.replace("qti3-player-color-", "")}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div class="profile-toggle-grid">
                        <ProfileCheckbox
                          label="Single column"
                          checked={state.profileForm.singleColumn}
                          onChange={(value) => {
                            state.profileForm.singleColumn = value;
                          }}
                        />
                        <ProfileCheckbox
                          label="TTS"
                          checked={state.profileForm.textToSpeech}
                          onChange={(value) => {
                            state.profileForm.textToSpeech = value;
                          }}
                        />
                        <ProfileCheckbox
                          label="Line reader"
                          checked={state.profileForm.lineReader}
                          onChange={(value) => {
                            state.profileForm.lineReader = value;
                          }}
                        />
                        <ProfileCheckbox
                          label="Masking"
                          checked={state.profileForm.answerMasking}
                          onChange={(value) => {
                            state.profileForm.answerMasking = value;
                          }}
                        />
                        <ProfileCheckbox
                          label="Assign now"
                          checked={state.createAndAssignProfile.value}
                          onChange={(value) => {
                            state.createAndAssignProfile.value = value;
                          }}
                        />
                      </div>
                      <fieldset class="profile-support-fieldset">
                        <legend>Media supports</legend>
                        <ProfileSupportModeControl
                          label="Transcript"
                          name="profile-support-transcript"
                          value={state.profileForm.transcriptMode}
                          onChange={(value) => {
                            state.profileForm.transcriptMode = value;
                          }}
                        />
                        <ProfileSupportModeControl
                          label="Captions"
                          name="profile-support-caption"
                          value={state.profileForm.captionMode}
                          onChange={(value) => {
                            state.profileForm.captionMode = value;
                          }}
                        />
                        <ProfileSupportModeControl
                          label="Audio description"
                          name="profile-support-audio-description"
                          value={state.profileForm.audioDescriptionMode}
                          onChange={(value) => {
                            state.profileForm.audioDescriptionMode = value;
                          }}
                        />
                        <ProfileSupportModeControl
                          label="Sign language"
                          name="profile-support-sign-language"
                          value={state.profileForm.signLanguageMode}
                          onChange={(value) => {
                            state.profileForm.signLanguageMode = value;
                          }}
                        />
                      </fieldset>
                      <label class="field profile-select-field">
                        <span>Language preferences</span>
                        <input
                          value={state.profileForm.pnpLanguages}
                          data-testid="profile-pnp-languages-input"
                          autoComplete="off"
                          placeholder="en, es"
                          onInput={(event) => {
                            state.profileForm.pnpLanguages = event.currentTarget.value;
                          }}
                        />
                      </label>
                      <button
                        class="primary-action"
                        type="button"
                        data-testid="create-accommodation-profile-button"
                        disabled={instructorWorkspaceBusy.value || !state.profileForm.name.trim()}
                        onClick={() => void createProfile()}
                      >
                        Create Profile
                      </button>
                    </details>
                  </div>
                </article>

                <article class="detail-section">
                  <div class="section-header">
                    <h3>Attempt controls and audit</h3>
                  </div>
                  <form
                    aria-label="Timing intervention"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!(event.submitter instanceof HTMLButtonElement)) return;
                      const type = event.submitter.value;
                      if (type === "extend-time" || type === "reopen-attempt")
                        void applyTimingAction(type);
                    }}
                  >
                    <div class="field-grid">
                      <label class="field field--span-two">
                        <span>Incident reason</span>
                        <textarea
                          required
                          rows={3}
                          value={state.incidentReason.value}
                          onInput={(event) => {
                            state.incidentReason.value = event.currentTarget.value;
                          }}
                        />
                      </label>
                      <label class="field">
                        <span>Minutes</span>
                        <input
                          required
                          type="number"
                          min="1"
                          step="1"
                          value={state.incidentMinutes.value}
                          onInput={(event) => {
                            state.incidentMinutes.value = event.currentTarget.value;
                          }}
                        />
                      </label>
                    </div>
                    <div class="card-actions">
                      <button
                        class="secondary-action"
                        type="submit"
                        name="action"
                        value="extend-time"
                        data-testid="grant-extra-time-button"
                        disabled={!state.selectedAttemptId.value || instructorWorkspaceBusy.value}
                      >
                        Extend time
                      </button>
                      <button
                        class="secondary-action"
                        type="submit"
                        name="action"
                        value="reopen-attempt"
                        data-testid="reopen-attempt-button"
                        disabled={!state.selectedAttemptId.value || instructorWorkspaceBusy.value}
                      >
                        Reopen
                      </button>
                    </div>
                  </form>

                  <section class="snapshot-evidence" data-testid="attempt-accommodation-snapshot">
                    <h3>Accommodation snapshot</h3>
                    <p>{state.attemptAccommodationSnapshotSummary.value}</p>
                  </section>

                  <section class="attempt-evidence-panel" data-testid="attempt-evidence-panel">
                    <div class="section-header">
                      <h3>Attempt evidence</h3>
                    </div>

                    {instructorAttemptEvidenceError.value ? (
                      <section class="feedback feedback--error" role="alert">
                        <strong>Evidence unavailable</strong>
                        <p>{instructorAttemptEvidenceError.value}</p>
                      </section>
                    ) : instructorAttemptEvidenceLoading.value ? (
                      <section class="feedback">
                        <strong>Loading</strong>
                      </section>
                    ) : !instructorAttemptEvidence.value ||
                      instructorAttemptEvidence.value.events.length === 0 ? (
                      <section class="feedback">
                        <strong>No evidence yet</strong>
                      </section>
                    ) : (
                      <>
                        <section class="evidence-summary" data-testid="attempt-evidence-summary">
                          <span class="summary-pill">
                            <strong>
                              {state.attemptEvidenceSummary.value.itemPresentationCount}
                            </strong>{" "}
                            shown
                          </span>
                          <span class="summary-pill">
                            <strong>{state.attemptEvidenceSummary.value.responseCount}</strong>{" "}
                            responses
                          </span>
                          <span class="summary-pill">
                            <strong>{state.attemptEvidenceSummary.value.submitCount}</strong>{" "}
                            submits
                          </span>
                          <span class="summary-pill">
                            <strong>{state.attemptEvidenceSummary.value.flaggedCount}</strong>{" "}
                            flagged
                          </span>
                        </section>

                        <section class="evidence-list" data-testid="attempt-evidence-list">
                          {state.visibleAttemptEvidenceEvents.value.map((event) => (
                            <article
                              key={event.id}
                              class="evidence-entry"
                              data-outcome={event.outcome}
                              data-evidence-event-id={event.id}
                              data-testid={`evidence-entry-${event.evidenceKind}`}
                              tabIndex={-1}
                            >
                              <div class="timeline-header">
                                <strong>{event.eventType}</strong>
                                <span>{event.outcome}</span>
                              </div>
                              <p>{event.itemRef?.itemId ?? "No item"}</p>
                              <p class="snapshot-meta">
                                {event.sequenceNumber === null
                                  ? "Seq n/a"
                                  : `Seq ${event.sequenceNumber}`}{" "}
                                · Recorded {formatTimestamp(event.serverTimestamp)}
                              </p>
                            </article>
                          ))}
                        </section>
                      </>
                    )}
                  </section>

                  {instructorAttemptTimelineError.value ? (
                    <section class="feedback feedback--error" role="alert">
                      <strong>Timeline unavailable</strong>
                      <p>{instructorAttemptTimelineError.value}</p>
                    </section>
                  ) : instructorAttemptTimelineLoading.value ? (
                    <section class="feedback">
                      <strong>Loading</strong>
                    </section>
                  ) : !instructorAttemptTimeline.value ||
                    (instructorAttemptTimeline.value.entries.length === 0 &&
                      !instructorAttemptTimeline.value.accommodationSnapshot) ? (
                    <section class="feedback">
                      <strong>No activity yet</strong>
                    </section>
                  ) : (
                    <section class="timeline-list" data-testid="attempt-timeline-list">
                      {instructorAttemptTimeline.value.accommodationSnapshot && (
                        <article
                          class="timeline-entry timeline-entry--accommodation"
                          data-testid="timeline-entry-accommodation-snapshot"
                        >
                          <div class="timeline-header">
                            <strong>accommodation-snapshot</strong>
                            <span>
                              {formatTimestamp(
                                instructorAttemptTimeline.value.accommodationSnapshot.createdAt,
                              )}
                            </span>
                          </div>
                          <p>{state.attemptAccommodationSnapshotSummary.value}</p>
                        </article>
                      )}
                      {instructorAttemptTimeline.value.entries.map((entry) => (
                        <article
                          key={entry.id}
                          class="timeline-entry"
                          data-testid={`timeline-entry-${entry.eventType}`}
                        >
                          <div class="timeline-header">
                            <strong>{entry.eventType}</strong>
                            <span>{formatTimestamp(entry.createdAt)}</span>
                          </div>
                          <p>{entry.reason || "No explicit reason recorded."}</p>
                        </article>
                      ))}
                    </section>
                  )}
                </article>
              </section>
            </details>
          </article>
        )}
      </section>
    </section>
  );
}
