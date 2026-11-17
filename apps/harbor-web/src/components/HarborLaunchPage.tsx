import type { HarborPage } from "@/App";
import { useHarborRuntime } from "@/lib/harbor-runtime";
import { ref, useSetup } from "@/lib/preact-reactivity";
import { issueRuntimeAccessCode, publishRuntimePackage } from "@/lib/runtime-session";

export default function HarborLaunchPage(_props: { navigateTo: (page: HarborPage) => void }) {
  const { accessCodeForm, launchAccessCode, launchPreview, loading, previewForm } =
    useHarborRuntime();

  const state = useSetup(() => ({
    importFile: ref<File | null>(null),
    importSlug: ref(""),
    importBusy: ref(false),
    importError: ref(""),
    importStatus: ref(""),
    importedAccessCode: ref(""),
  }));

  function handlePackageSelection(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0] ?? null;
    state.importFile.value = file;

    if (!file || state.importSlug.value.trim()) return;
    state.importSlug.value = slugify(file.name.replace(/\.[^.]+$/, ""));
  }

  async function importPackage(): Promise<void> {
    if (!state.importFile.value) {
      state.importError.value = "Choose a QTI ZIP first.";
      return;
    }

    const assessmentSlug = slugify(state.importSlug.value);
    if (!assessmentSlug) {
      state.importError.value = "Assessment name is required.";
      return;
    }

    state.importBusy.value = true;
    state.importError.value = "";
    state.importStatus.value = "Importing...";

    try {
      const published = await publishRuntimePackage({
        tenantId: "tenant_local_demo",
        assessmentSlug,
        packageName: state.importFile.value.name,
        packageBytes: await state.importFile.value.arrayBuffer(),
      });
      const issued = await issueRuntimeAccessCode({
        assessmentVersionId: published.assessmentVersionId,
      });

      previewForm.assessmentVersionId = published.assessmentVersionId;
      accessCodeForm.assessmentVersionId = published.assessmentVersionId;
      accessCodeForm.accessCode = issued.accessCode;
      accessCodeForm.actorId = accessCodeForm.actorId.trim() || "student-demo";
      accessCodeForm.actorDisplayName = accessCodeForm.actorDisplayName.trim() || "Student Demo";
      state.importedAccessCode.value = issued.accessCode;
      state.importStatus.value = "Ready to launch.";
    } catch (error) {
      state.importError.value =
        error instanceof Error && error.message.trim()
          ? error.message
          : "Could not import this QTI ZIP.";
      state.importStatus.value = "";
    } finally {
      state.importBusy.value = false;
    }
  }

  return (
    <section class="launch-page">
      <div class="launch-intro">
        <h1>Launch assessment</h1>
      </div>

      <section class="launch-stack">
        <article class="launch-card">
          <header class="card-header">
            <h2>Import QTI ZIP</h2>
            <button
              class="primary-action"
              type="button"
              disabled={loading.value || state.importBusy.value || !state.importFile.value}
              onClick={() => void importPackage()}
            >
              Import ZIP
            </button>
          </header>

          <div class="field-row">
            <label class="field">
              <span>QTI ZIP</span>
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(event) => handlePackageSelection(event)}
              />
            </label>

            <label class="field">
              <span>Slug</span>
              <input
                value={state.importSlug.value}
                name="importSlug"
                autocomplete="off"
                placeholder="us-presidents-sampler"
                onInput={(event) => {
                  state.importSlug.value = (event.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
          </div>

          {state.importedAccessCode.value && (
            <div class="import-summary">
              <span class="import-pill import-pill--ready">Imported</span>
              <span class="import-pill">
                Code <strong>{state.importedAccessCode.value}</strong>
              </span>
            </div>
          )}

          {state.importStatus.value && <p class="import-feedback">{state.importStatus.value}</p>}
          {state.importError.value && (
            <p class="import-feedback import-feedback--error" role="alert">
              {state.importError.value}
            </p>
          )}

          <div class="import-actions">
            <button
              class="secondary-action"
              type="button"
              disabled={
                loading.value || state.importBusy.value || !previewForm.assessmentVersionId.trim()
              }
              onClick={() => void launchPreview()}
            >
              Preview as instructor
            </button>
            <button
              class="secondary-action"
              type="button"
              disabled={loading.value || state.importBusy.value || !state.importedAccessCode.value}
              onClick={() => void launchAccessCode()}
            >
              Take as student
            </button>
          </div>
        </article>

        <article class="launch-card">
          <header class="card-header">
            <h2>Start with access code</h2>
            <button
              class="primary-action"
              type="button"
              disabled={loading.value || !accessCodeForm.accessCode.trim()}
              onClick={() => void launchAccessCode()}
            >
              Start session
            </button>
          </header>

          <div class="field-row">
            <label class="field field--span-two">
              <span>Access Code</span>
              <input
                value={accessCodeForm.accessCode}
                name="accessCode"
                autocomplete="off"
                placeholder="HBR-...."
                onInput={(event) => {
                  accessCodeForm.accessCode = (event.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
          </div>

          <div class="field-row">
            <label class="field">
              <span>Candidate ID</span>
              <input
                value={accessCodeForm.actorId}
                name="candidateId"
                autocomplete="off"
                placeholder="optional"
                onInput={(event) => {
                  accessCodeForm.actorId = (event.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>

            <label class="field">
              <span>Candidate Name</span>
              <input
                value={accessCodeForm.actorDisplayName}
                name="candidateName"
                autocomplete="off"
                placeholder="Student Candidate"
                onInput={(event) => {
                  accessCodeForm.actorDisplayName = (event.currentTarget as HTMLInputElement).value;
                }}
              />
            </label>
          </div>
        </article>
      </section>
    </section>
  );
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
