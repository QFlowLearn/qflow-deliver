import { computed, onMounted, ref, useSetup } from "@/lib/preact-reactivity";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import type { InstructorLmsWorkspaceResponse } from "@harbor/attempt-protocol";

type ResourceLink = InstructorLmsWorkspaceResponse["resourceLinks"][number];

export default function HarborInstructorLmsPage() {
  const {
    instructorLmsError,
    instructorLmsIntegration,
    instructorLmsLoading,
    instructorLmsSchedulingResourceLinkId,
    instructorLmsStatus,
    instructorLmsSyncingAttemptId,
    buildInstructorLmsEvidenceReportUrl,
    refreshInstructorLmsIntegrations,
    scheduleInstructorLmsNrps,
    syncInstructorLmsNrps,
  } = useHarborRuntime();

  const state = useSetup(() => {
    const registrationCopyStatus = ref<"idle" | "copied" | "failed">("idle");
    const registrations = computed(() => instructorLmsIntegration.value?.registrations ?? []);
    const resourceLinks = computed(() => instructorLmsIntegration.value?.resourceLinks ?? []);
    const deepLinkPlacements = computed(
      () => instructorLmsIntegration.value?.deepLinkPlacements ?? [],
    );
    const nrpsSyncRuns = computed(() => instructorLmsIntegration.value?.nrpsSyncRuns ?? []);
    const agsReadyCount = computed(
      () => resourceLinks.value.filter((link) => link.agsAvailable).length,
    );
    const nrpsReadyCount = computed(
      () =>
        resourceLinks.value.filter(
          (link) => link.nrpsAvailable && link.latestAttemptId && link.sectionId,
        ).length,
    );

    onMounted(() => {
      void refreshInstructorLmsIntegrations();
    });

    return {
      agsReadyCount,
      deepLinkPlacements,
      nrpsReadyCount,
      nrpsSyncRuns,
      registrationCopyStatus,
      registrations,
      resourceLinks,
    };
  });

  return (
    <section class="lms-page" data-testid="instructor-lms-page">
      <section class="lms-hero">
        <div>
          <p class="section-kicker">LMS Integrations</p>
          <h1 data-testid="instructor-lms-title">LTI evidence and roster sync</h1>
          <p>{instructorLmsStatus.value}</p>
        </div>
        <div class="lms-actions">
          <a
            class="secondary-action"
            href={buildInstructorLmsEvidenceReportUrl()}
            data-testid="lms-evidence-report-button"
          >
            Evidence report
          </a>
          <button
            class="secondary-action"
            type="button"
            data-testid="lms-refresh-button"
            disabled={instructorLmsLoading.value}
            onClick={() => void refreshInstructorLmsIntegrations()}
          >
            {instructorLmsLoading.value ? "Refreshing" : "Refresh"}
          </button>
        </div>
      </section>

      <section class="lms-summary" aria-label="LMS integration summary">
        <span class="summary-pill">
          <strong>{state.registrations.value.length}</strong> registrations
        </span>
        <span class="summary-pill">
          <strong>{state.resourceLinks.value.length}</strong> resource links
        </span>
        <span class="summary-pill">
          <strong>{state.deepLinkPlacements.value.length}</strong> Deep Linking placements
        </span>
        <span class="summary-pill">
          <strong>{state.agsReadyCount.value}</strong> AGS ready
        </span>
        <span class="summary-pill">
          <strong>{state.nrpsReadyCount.value}</strong> NRPS sync ready
        </span>
      </section>

      {instructorLmsError.value ? (
        <section class="lms-empty lms-empty--error" data-testid="lms-error">
          <strong>LMS evidence unavailable</strong>
          <p>{instructorLmsError.value}</p>
        </section>
      ) : instructorLmsLoading.value && !instructorLmsIntegration.value ? (
        <section class="lms-empty">
          <strong>Reading LMS ledgers</strong>
          <p>QFlowLearn Delivery is loading registrations, placements, launches, and sync runs.</p>
        </section>
      ) : (
        <>
          <section class="lms-section lms-registration-setup">
            <div class="section-heading">
              <div>
                <p class="section-kicker">Connect an LMS</p>
                <h2>Dynamic registration</h2>
              </div>
            </div>
            <p class="lms-section-copy">
              Paste this tenant-specific URL into your LMS registration screen. QFlowLearn Delivery
              configures LTI launches, Deep Linking, grade passback, and roster access.
            </p>
            <div class="lms-registration-url">
              <label for="lms-registration-url">Registration URL</label>
              <div class="lms-registration-url__control">
                <input
                  id="lms-registration-url"
                  type="url"
                  readOnly
                  value={instructorLmsIntegration.value?.setup.dynamicRegistrationUrl ?? ""}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <button
                  class="secondary-action"
                  type="button"
                  disabled={!instructorLmsIntegration.value?.setup.dynamicRegistrationUrl}
                  onClick={() => void copyDynamicRegistrationUrl()}
                >
                  {copyButtonLabel(state.registrationCopyStatus.value)}
                </button>
              </div>
              {state.registrationCopyStatus.value === "failed" && (
                <span class="lms-registration-url__status" aria-live="polite">
                  Copy failed. Select the URL and copy it manually.
                </span>
              )}
            </div>
          </section>

          <section class="lms-section">
            <div class="section-heading">
              <div>
                <p class="section-kicker">Registrations</p>
                <h2>Connected LTI platforms</h2>
              </div>
            </div>
            {state.registrations.value.length === 0 ? (
              <div class="lms-empty">
                <strong>No registrations</strong>
                <p>LTI registrations will appear here after setup.</p>
              </div>
            ) : (
              <div class="lms-list">
                {state.registrations.value.map((registration) => (
                  <article
                    key={registration.id}
                    class="lms-row"
                    data-testid={`lms-registration-${registration.id}`}
                  >
                    <div class="lms-row-main">
                      <strong>{registration.issuer}</strong>
                      <p>
                        Client {registration.clientId} · Deployment {registration.deploymentId}
                      </p>
                    </div>
                    <div class="lms-row-meta">
                      <span>{registration.resourceLinkCount} links</span>
                      <span>{registration.deepLinkPlacementCount} placements</span>
                      <span>{registration.agsLaunchCount} AGS launches</span>
                      <span>{registration.nrpsLaunchCount} NRPS launches</span>
                      <span>Last launch {formatDate(registration.lastLaunchAt)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section class="lms-section">
            <div class="section-heading">
              <div>
                <p class="section-kicker">Resource Links</p>
                <h2>Mapped assignments</h2>
              </div>
            </div>
            {state.resourceLinks.value.length === 0 ? (
              <div class="lms-empty">
                <strong>No mapped resource links</strong>
                <p>Deep Linking or assignment linkage records will appear here.</p>
              </div>
            ) : (
              <div class="lms-list">
                {state.resourceLinks.value.map((link) => (
                  <article
                    key={link.id}
                    class="lms-row lms-row--actionable"
                    data-testid={`lms-resource-link-${link.id}`}
                  >
                    <div class="lms-row-main">
                      <strong>{link.assignmentTitle}</strong>
                      <p>
                        Resource {link.resourceLinkId} · {link.sectionTitle ?? "No linked section"}
                      </p>
                    </div>
                    <div class="lms-row-meta">
                      <span>AGS {formatBoolean(link.agsAvailable)}</span>
                      <span>NRPS {formatBoolean(link.nrpsAvailable)}</span>
                      <span>Latest launch {formatDate(link.latestLaunchAt)}</span>
                      <span>Last sync {formatDate(link.latestNrpsSync?.completedAt ?? null)}</span>
                      <span>
                        Schedule{" "}
                        {link.nrpsSyncSchedule?.enabled
                          ? `every ${link.nrpsSyncSchedule.intervalMinutes}m`
                          : "off"}
                      </span>
                      <span>
                        Policy {link.nrpsSyncSchedule?.reconciliationPolicy ?? "additive-only"}
                      </span>
                      <span>Next run {formatDate(link.nrpsSyncSchedule?.nextRunAt ?? null)}</span>
                      {link.nrpsSyncSchedule?.lastErrorMessage && (
                        <span class="lms-error-pill">{link.nrpsSyncSchedule.lastErrorMessage}</span>
                      )}
                    </div>
                    <div class="lms-row-actions">
                      <button
                        class="secondary-action"
                        type="button"
                        disabled={
                          !canSyncNrps(link) ||
                          instructorLmsSyncingAttemptId.value === link.latestAttemptId
                        }
                        data-testid={`lms-sync-nrps-${link.id}`}
                        onClick={() => void syncNrps(link)}
                      >
                        {instructorLmsSyncingAttemptId.value === link.latestAttemptId
                          ? "Syncing"
                          : "Sync LMS roster"}
                      </button>
                      <button
                        class="secondary-action"
                        type="button"
                        disabled={
                          !canSyncNrps(link) ||
                          instructorLmsSchedulingResourceLinkId.value === link.id
                        }
                        data-testid={`lms-schedule-nrps-${link.id}`}
                        onClick={() => void toggleNrpsSchedule(link)}
                      >
                        {instructorLmsSchedulingResourceLinkId.value === link.id
                          ? "Updating"
                          : link.nrpsSyncSchedule?.enabled
                            ? "Pause schedule"
                            : "Schedule daily sync"}
                      </button>
                      <button
                        class="secondary-action"
                        type="button"
                        disabled={
                          !canSyncNrps(link) ||
                          instructorLmsSchedulingResourceLinkId.value === link.id
                        }
                        data-testid={`lms-reconcile-nrps-${link.id}`}
                        onClick={() => void toggleNrpsReconciliationPolicy(link)}
                      >
                        {link.nrpsSyncSchedule?.reconciliationPolicy === "mark-inactive"
                          ? "Use additive sync"
                          : "Mark missing inactive"}
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section class="lms-section">
            <div class="section-heading">
              <div>
                <p class="section-kicker">Deep Linking</p>
                <h2>Placement evidence</h2>
              </div>
            </div>
            {state.deepLinkPlacements.value.length === 0 ? (
              <div class="lms-empty">
                <strong>No Deep Linking placements</strong>
                <p>
                  QFlowLearn Delivery will retain placement keys and first-launch bindings here.
                </p>
              </div>
            ) : (
              <div class="lms-table-wrap">
                <table class="lms-table">
                  <thead>
                    <tr>
                      <th>Placement</th>
                      <th>Assignment</th>
                      <th>Section</th>
                      <th>Linked resource</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.deepLinkPlacements.value.map((placement) => (
                      <tr key={placement.id}>
                        <td>{placement.title}</td>
                        <td>{placement.assignmentTitle}</td>
                        <td>{placement.sectionTitle ?? "Unmapped"}</td>
                        <td>{placement.linkedResourceLinkId ?? "Waiting for launch"}</td>
                        <td>{formatDate(placement.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section class="lms-section">
            <div class="section-heading">
              <div>
                <p class="section-kicker">NRPS</p>
                <h2>Roster sync runs</h2>
              </div>
            </div>
            {state.nrpsSyncRuns.value.length === 0 ? (
              <div class="lms-empty">
                <strong>No NRPS sync runs</strong>
                <p>Manual LMS roster sync results will appear here.</p>
              </div>
            ) : (
              <div class="lms-list">
                {state.nrpsSyncRuns.value.map((run) => (
                  <article key={run.runId} class="lms-row" data-status={run.status}>
                    <div class="lms-row-main">
                      <strong>{run.status === "complete" ? "Complete" : "Failed"}</strong>
                      <p>
                        {run.learnerMembershipsUpserted} learner membership(s),{" "}
                        {run.learnerMembershipsDeactivated} deactivated, {run.skippedMembers}{" "}
                        skipped · Section {run.sectionId}
                      </p>
                      {run.errorMessage && <p class="lms-error-copy">{run.errorMessage}</p>}
                    </div>
                    <div class="lms-row-meta">
                      <span>{run.totalMembers} members</span>
                      <span>{formatDate(run.startedAt)}</span>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </section>
  );

  async function syncNrps(link: ResourceLink): Promise<void> {
    if (!link.latestAttemptId) return;
    await syncInstructorLmsNrps({ attemptId: link.latestAttemptId });
  }

  async function copyDynamicRegistrationUrl(): Promise<void> {
    const url = instructorLmsIntegration.value?.setup.dynamicRegistrationUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      state.registrationCopyStatus.value = "copied";
      globalThis.setTimeout(() => {
        state.registrationCopyStatus.value = "idle";
      }, 1600);
    } catch {
      state.registrationCopyStatus.value = "failed";
    }
  }

  async function toggleNrpsSchedule(link: ResourceLink): Promise<void> {
    if (!canSyncNrps(link)) return;
    await scheduleInstructorLmsNrps({
      resourceLinkId: link.id,
      enabled: !link.nrpsSyncSchedule?.enabled,
      intervalMinutes: link.nrpsSyncSchedule?.intervalMinutes ?? 1440,
      reconciliationPolicy: link.nrpsSyncSchedule?.reconciliationPolicy ?? "additive-only",
    });
  }

  async function toggleNrpsReconciliationPolicy(link: ResourceLink): Promise<void> {
    if (!canSyncNrps(link)) return;
    const currentPolicy = link.nrpsSyncSchedule?.reconciliationPolicy ?? "additive-only";
    await scheduleInstructorLmsNrps({
      resourceLinkId: link.id,
      enabled: true,
      intervalMinutes: link.nrpsSyncSchedule?.intervalMinutes ?? 1440,
      reconciliationPolicy: currentPolicy === "mark-inactive" ? "additive-only" : "mark-inactive",
    });
  }
}

function copyButtonLabel(status: "idle" | "copied" | "failed"): string {
  if (status === "copied") return "Copied";
  if (status === "failed") return "Try again";
  return "Copy URL";
}

function canSyncNrps(link: ResourceLink): boolean {
  return Boolean(link.latestAttemptId && link.sectionId && link.nrpsAvailable);
}

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatBoolean(value: boolean): string {
  return value ? "Available" : "Unavailable";
}
