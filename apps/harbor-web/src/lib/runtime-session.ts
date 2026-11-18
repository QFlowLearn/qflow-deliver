import { parseAnswerFeedbackResponse, type AnswerFeedbackResponse } from "@harbor/content-model";
import {
  parseAssignmentStaffCapabilities,
  type AssignmentStaffCapabilities,
} from "@harbor/attempt-protocol";
import type {
  AssignmentActorSnapshot,
  AssignmentReadResponse,
  AssignmentHistoryResponse,
  AssignmentLearnerOverrideRecord,
  AttemptEvidenceResponse,
  AttemptPolicyReadResponse,
  AttemptPolicyState,
  AttemptResultStatus,
  AttemptTimelineResponse,
  AssessmentImportValidationReport,
  BootstrapEnvelope,
  BootstrapPayload,
  CreateScoreAmendmentRequest,
  CreateScoreAmendmentResponse,
  CreateAssignmentRequest,
  DeactivateScoreAmendmentRequest,
  DeactivateScoreAmendmentResponse,
  DeliveryContextEvaluation,
  DeliveryPolicySnapshot,
  HarborAccommodationProfileDefinition,
  InstructorAssignmentListResponse,
  InstructorLearnerReportResponse,
  InstructorAssignmentReportingResponse,
  InstructorAssignmentResultsResponse,
  InstructorAssignmentRosterResponse,
  InstructorLearnersResponse,
  InstructorPublishedAssessmentVersionListResponse,
  InstructorLmsWorkspaceResponse,
  InstructorLmsNrpsScheduleResponse,
  InstructorLmsNrpsSyncResponse,
  ManualScoringAttemptResponse,
  ManualScoringQueueResponse,
  SaveManualScoreRequest,
  SaveManualScoreResponse,
  FinalizeManualScoringRequest,
  FinalizeManualScoringResponse,
  InstructorSectionsResponse,
  InstitutionalSessionResponse,
  LaunchMode,
  OperatorAttemptActionRequest,
  ProvisioningRunDetailResponse,
  ProvisioningRunsResponse,
  ReportExportCatalogResponse,
  ResultOpsFilterOptionsSnapshot,
  ResultOpsRowContextSnapshot,
  ResultExportStateSnapshot,
  ResultFinalizationStatus,
  ResultOpsSummarySnapshot,
  ResultRemediationRequestRecord,
  ResultRemediationScope,
  ResultRemediationStateSnapshot,
  ScoreAmendmentEvidenceExportResponse,
  ScoreAmendmentPreviewResponse,
  ScoreAmendmentsResponse,
  StudentAssignmentListResponse,
  StudentSafeExamBrowserLaunchResponse,
  UpdateAssignmentRequest,
  RosterCsvImportResponse,
  QtiItemSessionControlSnapshot,
  QtiTimeLimitsSnapshot,
  QtiTimingMetadataSnapshot,
} from "@harbor/attempt-protocol";
import {
  parseAssessmentInstructionBlocks,
  type AssessmentInstructionBlock,
} from "@harbor/content-model";

const DELIVERY_CONTEXT_FRAME_MODE_HEADER = "x-harbor-frame-mode";
const DELIVERY_CONTEXT_EMBED_ORIGIN_HEADER = "x-harbor-embed-origin";
const DELIVERY_CONTEXT_SECURE_BROWSER_PROVIDER_HEADER = "x-harbor-secure-browser-provider";
const HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER = "x-harbor-seb-js-configkeyhash";
const HARBOR_SAFE_EXAM_BROWSER_JS_REQUEST_HASH_HEADER = "x-harbor-seb-js-requesthash";
const HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER = "x-harbor-seb-js-proof-url";

export class RuntimeSessionError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly deliveryContext?: DeliveryContextEvaluation | null,
  ) {
    super(message);
  }
}

export interface RuntimeBootstrapSession {
  envelope: BootstrapEnvelope;
  payload: BootstrapPayload;
}

export interface RuntimeManifestSummary {
  assessmentInstructions: readonly AssessmentInstructionBlock[];
  testSequence?: { answered: number; target: number };
  attemptId: string;
  assessmentVersionId: string;
  title: string;
  launchMode: LaunchMode;
  deliveryPolicy: DeliveryPolicySnapshot;
  currentItemId: string;
  itemOrder: string[];
  items: Record<
    string,
    {
      id: string;
      identifier: string;
      title: string;
      itemHref: string;
      assetIds: string[];
      maxScore: number | null;
      timeDependent?: boolean;
      timeLimits?: QtiTimeLimitsSnapshot | null;
      itemSessionControl?: QtiItemSessionControlSnapshot | null;
    }
  >;
  qtiTiming?: QtiTimingMetadataSnapshot | null;
}

export interface RuntimeItemPayload {
  attemptId: string;
  assessmentVersionId: string;
  item: {
    id: string;
    identifier: string;
    title: string;
    href: string;
    timeDependent?: boolean;
    timeLimits?: QtiTimeLimitsSnapshot | null;
    itemSessionControl?: QtiItemSessionControlSnapshot | null;
    xml: string;
    assets: Array<{
      id: string;
      href: string;
      url: string;
      mediaType: string;
      sizeBytes: number;
      sha256: string | null;
    }>;
  };
}

export interface RuntimeShellContent {
  manifest: RuntimeManifestSummary;
  currentItem: RuntimeItemPayload;
}

export interface RuntimePolicyProjection extends AttemptPolicyReadResponse {}

export interface RuntimePublishResult {
  assessmentId: string;
  assessmentVersionId: string;
  packageObjectKey: string;
  manifestObjectKey: string;
  validation?: AssessmentImportValidationReport;
}

export interface RuntimeIssuedAccessCode {
  accessCodeId: string;
  accessCode: string;
  assessmentVersionId: string;
  expiresAt: string | null;
}

export interface RuntimeAssessmentHistory extends AssignmentHistoryResponse {}

export interface RuntimeInstitutionalSession extends InstitutionalSessionResponse {}

export interface RuntimeStudentAssignments extends StudentAssignmentListResponse {}

export interface RuntimeStudentSafeExamBrowserLaunch extends StudentSafeExamBrowserLaunchResponse {}

export interface RuntimeInstructorAssignments extends InstructorAssignmentListResponse {}

export interface RuntimeInstructorPublishedAssessmentVersions extends InstructorPublishedAssessmentVersionListResponse {}

export interface RuntimeInstructorSections extends InstructorSectionsResponse {}

export interface RuntimeInstructorLearners extends InstructorLearnersResponse {}

export interface RuntimeInstructorLmsNrpsSync extends InstructorLmsNrpsSyncResponse {}

export interface RuntimeInstructorLmsNrpsSchedule extends InstructorLmsNrpsScheduleResponse {}

export interface RuntimeInstructorAssignment extends AssignmentReadResponse {}

export interface RuntimeInstructorRoster extends InstructorAssignmentRosterResponse {}

export interface RuntimeInstructorResults extends InstructorAssignmentResultsResponse {}

export interface RuntimeInstructorAssignmentReport extends InstructorAssignmentReportingResponse {}

export interface RuntimeInstructorLearnerReport extends InstructorLearnerReportResponse {}

export interface RuntimeManualScoringQueue extends ManualScoringQueueResponse {}

export interface RuntimeManualScoringAttempt extends ManualScoringAttemptResponse {}

export interface RuntimeSaveManualScoreResponse extends SaveManualScoreResponse {}

export interface RuntimeFinalizeManualScoringResponse extends FinalizeManualScoringResponse {}

export interface RuntimeReportExportCatalog extends ReportExportCatalogResponse {}

export interface RuntimeAssignmentLearnerOverride extends AssignmentLearnerOverrideRecord {}

export interface RuntimeAccommodationProfile {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "inactive";
  profile: HarborAccommodationProfileDefinition;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeAccommodationProfilesResponse {
  profiles: RuntimeAccommodationProfile[];
}

export interface RuntimeLearnerAccommodationAssignment {
  id: string;
  tenantId: string;
  learnerId: string;
  profileId: string;
  profileName: string;
  status: "active" | "inactive";
  sourceKind: string;
  effectiveAt: string;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeLearnerAccommodationAssignmentsResponse {
  assignments: RuntimeLearnerAccommodationAssignment[];
}

export interface RuntimeAttemptTimeline extends AttemptTimelineResponse {}

export interface RuntimeAttemptEvidence extends AttemptEvidenceResponse {}

export interface RuntimeScoreAmendmentsResponse extends ScoreAmendmentsResponse {}

export interface RuntimeCreateScoreAmendmentResponse extends CreateScoreAmendmentResponse {}

export interface RuntimeDeactivateScoreAmendmentResponse extends DeactivateScoreAmendmentResponse {}

export interface RuntimeScoreAmendmentPreview extends ScoreAmendmentPreviewResponse {}

export interface RuntimeScoreAmendmentEvidenceExport extends ScoreAmendmentEvidenceExportResponse {}

export interface RuntimeResultsOpsRow {
  attemptId: string;
  assignmentId: string | null;
  assessmentVersionId: string;
  sourceReceiptId: string;
  context: ResultOpsRowContextSnapshot;
  finalization: {
    finalizationId: string;
    status: ResultFinalizationStatus;
    errorMessage: string | null;
    submittedAt: string;
    finalizedAt: string | null;
    updatedAt: string;
  };
  result: {
    status: AttemptResultStatus;
    totalScore: number | null;
    maxScore: number | null;
    passed: boolean | null;
    finalizedAt: string | null;
  } | null;
  export: ResultExportStateSnapshot | null;
  remediation: ResultRemediationStateSnapshot;
}

export interface RuntimeResultsOpsResponse {
  rows: RuntimeResultsOpsRow[];
  summary: ResultOpsSummarySnapshot;
  filters: ResultOpsFilterOptionsSnapshot;
}

export interface RuntimeResultsOpsFilters {
  tenantId?: string;
  assignmentId?: string;
}

export interface RuntimeResultsOpsRetryRequest {
  scope: ResultRemediationScope;
  actor: AssignmentActorSnapshot;
  reason: string;
}

export interface RuntimeResultsOpsRetryResponse {
  request: ResultRemediationRequestRecord;
  existing: boolean;
}

export interface RuntimeProvisioningRuns extends ProvisioningRunsResponse {}

export interface RuntimeProvisioningRunDetail extends ProvisioningRunDetailResponse {}

export interface RuntimeRosterCsvImportResponse extends RosterCsvImportResponse {}

export const DEFAULT_RENDERER_PNP = {
  textAppearance: {
    colorStyle: "qti3-player-color-default",
  },
  glossaryOnScreen: true,
  keywordTranslationLanguage: "",
  extSbacGlossaryIllustration: false,
  layoutSingleColumn: false,
} as const;

export const DEFAULT_RENDERER_SESSION_CONTROL = {
  allow_comment: false,
  allow_review: true,
  allow_skipping: true,
  max_attempts: 0,
  show_feedback: false,
  show_solution: false,
  time_limits: {
    min_time: null,
    max_time: null,
    allow_late_submission: false,
  },
  validate_responses: true,
} as const;

export async function loadAttemptPolicy(input: {
  attemptId: string;
}): Promise<RuntimePolicyProjection> {
  return getJson<RuntimePolicyProjection>(
    `/api/attempts/${encodeURIComponent(input.attemptId)}/policy`,
  );
}

export async function loadAssessmentHistory(
  input: {
    attemptId: string;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<RuntimeAssessmentHistory> {
  return getJson<RuntimeAssessmentHistory>(
    `/api/attempts/${encodeURIComponent(input.attemptId)}/history`,
    options,
  );
}

export async function publishRuntimePackage(input: {
  tenantId: string;
  assessmentSlug: string;
  packageName: string;
  packageBytes: ArrayBuffer | Uint8Array;
}): Promise<RuntimePublishResult> {
  const headers = await createRuntimeContextHeaders();
  headers.set("content-type", "application/zip");
  headers.set("x-harbor-tenant-id", input.tenantId);
  headers.set("x-harbor-package-name", input.packageName);

  const response = await fetch(
    `/internal/publish?assessmentSlug=${encodeURIComponent(input.assessmentSlug)}`,
    {
      method: "POST",
      headers,
      body: (input.packageBytes instanceof Uint8Array
        ? input.packageBytes
        : new Uint8Array(input.packageBytes)) as unknown as BodyInit,
    },
  );

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.json() as Promise<RuntimePublishResult>;
}

export async function issueRuntimeAccessCode(input: {
  assessmentVersionId: string;
  code?: string;
}): Promise<RuntimeIssuedAccessCode> {
  return postJson<RuntimeIssuedAccessCode>("/internal/access-codes", {
    assessmentVersionId: input.assessmentVersionId,
    code: input.code,
  });
}

export function resolveRendererPnp(policy: AttemptPolicyState) {
  return {
    ...DEFAULT_RENDERER_PNP,
    ...policy.accommodations.rendererPnp,
    textAppearance: {
      ...DEFAULT_RENDERER_PNP.textAppearance,
      ...policy.accommodations.rendererPnp.textAppearance,
    },
  };
}

export function resolveRendererSessionControl(policy: AttemptPolicyState) {
  return {
    ...DEFAULT_RENDERER_SESSION_CONTROL,
    ...policy.accommodations.sessionControl,
    time_limits: {
      ...DEFAULT_RENDERER_SESSION_CONTROL.time_limits,
      ...policy.accommodations.sessionControl.time_limits,
    },
  };
}

interface ActorInput {
  id?: string | null;
  displayName?: string | null;
}

export interface PreviewLaunchInput {
  assessmentVersionId: string;
  actor?: ActorInput;
  clientSessionId?: string;
}

export interface AccessCodeLaunchInput {
  accessCode: string;
  assessmentVersionId?: string;
  actor?: ActorInput;
  clientSessionId?: string;
}

export interface StudentLaunchInput {
  assignmentId: string;
  source?: "institutional-sso" | "lti";
  clientSessionId?: string;
  safeExamBrowserLaunchToken?: string;
}

export async function requestPreviewBootstrap(
  input: PreviewLaunchInput,
): Promise<RuntimeBootstrapSession> {
  const envelope = await postJson<BootstrapEnvelope>("/api/launch/preview", {
    assessmentVersionId: input.assessmentVersionId,
    actor: sanitizeActor(input.actor),
  });

  return {
    envelope,
    payload: await exchangeRuntimeBootstrapToken(envelope.bootstrapToken, input.clientSessionId),
  };
}

export async function requestAccessCodeBootstrap(
  input: AccessCodeLaunchInput,
): Promise<RuntimeBootstrapSession> {
  const envelope = await postJson<BootstrapEnvelope>("/api/launch/access-code", {
    accessCode: input.accessCode,
    assessmentVersionId: input.assessmentVersionId,
    actor: sanitizeActor(input.actor),
  });

  return {
    envelope,
    payload: await exchangeRuntimeBootstrapToken(envelope.bootstrapToken, input.clientSessionId),
  };
}

export async function requestStudentBootstrap(
  input: StudentLaunchInput,
): Promise<RuntimeBootstrapSession> {
  const envelope = await postJson<BootstrapEnvelope>("/api/launch/student", {
    assignmentId: input.assignmentId,
    source: input.source ?? "institutional-sso",
    safeExamBrowserLaunchToken: input.safeExamBrowserLaunchToken,
  });

  return {
    envelope,
    payload: await exchangeRuntimeBootstrapToken(envelope.bootstrapToken, input.clientSessionId),
  };
}

export async function requestStudentSafeExamBrowserLaunch(
  assignmentId: string,
): Promise<RuntimeStudentSafeExamBrowserLaunch> {
  return postJson<RuntimeStudentSafeExamBrowserLaunch>(
    `/api/student/assignments/${encodeURIComponent(assignmentId)}/safe-exam-browser/launch`,
    {},
  );
}

export async function loadInstitutionalSession(): Promise<RuntimeInstitutionalSession> {
  return getJson<RuntimeInstitutionalSession>("/api/auth/session");
}

export async function loginWithPassword(input: {
  tenantId?: string;
  usernameOrEmail: string;
  password: string;
}): Promise<RuntimeInstitutionalSession> {
  return postJson<RuntimeInstitutionalSession>("/api/auth/password/login", {
    tenantId: input.tenantId,
    usernameOrEmail: input.usernameOrEmail,
    password: input.password,
  });
}

export async function requestPasswordReset(input: {
  tenantId?: string;
  usernameOrEmail: string;
}): Promise<void> {
  await postJson<{ ok: boolean }>("/api/auth/password/forgot", {
    tenantId: input.tenantId,
    usernameOrEmail: input.usernameOrEmail,
  });
}

export async function completePasswordReset(input: {
  token: string;
  password: string;
}): Promise<void> {
  await postJson<{ ok: boolean }>("/api/auth/password/reset", {
    token: input.token,
    password: input.password,
  });
}

export async function loadStudentAssignments(): Promise<RuntimeStudentAssignments> {
  return getJson<RuntimeStudentAssignments>("/api/student/assignments");
}

export async function loadInstructorAssignments(): Promise<RuntimeInstructorAssignments> {
  return getJson<RuntimeInstructorAssignments>("/api/instructor/assignments");
}

export async function loadInstructorPublishedAssessmentVersions(): Promise<RuntimeInstructorPublishedAssessmentVersions> {
  return getJson<RuntimeInstructorPublishedAssessmentVersions>(
    "/api/instructor/assessment-versions",
  );
}

export async function loadInstructorSections(): Promise<RuntimeInstructorSections> {
  return getJson<RuntimeInstructorSections>("/api/instructor/sections");
}

export async function loadInstructorLearners(input: {
  search?: string;
  learnerIds?: string[];
}): Promise<RuntimeInstructorLearners> {
  const params = new URLSearchParams();
  const search = input.search?.trim();
  if (search) {
    params.set("search", search);
  }
  if (input.learnerIds && input.learnerIds.length > 0) {
    params.set("ids", input.learnerIds.join(","));
  }
  const query = params.toString();
  return getJson<RuntimeInstructorLearners>(
    query ? `/api/instructor/learners?${query}` : "/api/instructor/learners",
  );
}

export async function createInstructorAssignment(
  input: CreateAssignmentRequest,
): Promise<RuntimeInstructorAssignment> {
  return postJson<RuntimeInstructorAssignment>("/api/instructor/assignments", input);
}

export async function loadInstructorAssignment(
  assignmentId: string,
): Promise<RuntimeInstructorAssignment> {
  return getJson<RuntimeInstructorAssignment>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}`,
  );
}

export async function updateInstructorAssignment(input: {
  assignmentId: string;
  request: UpdateAssignmentRequest;
}): Promise<RuntimeInstructorAssignment> {
  return putJson<RuntimeInstructorAssignment>(
    `/api/instructor/assignments/${encodeURIComponent(input.assignmentId)}`,
    input.request,
  );
}

export async function activateInstructorAssignment(
  assignmentId: string,
): Promise<RuntimeInstructorAssignment> {
  return postJson<RuntimeInstructorAssignment>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/activate`,
    {},
  );
}

export async function closeInstructorAssignment(
  assignmentId: string,
): Promise<RuntimeInstructorAssignment> {
  return postJson<RuntimeInstructorAssignment>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/close`,
    {},
  );
}

export async function loadInstructorRoster(assignmentId: string): Promise<RuntimeInstructorRoster> {
  return getJson<RuntimeInstructorRoster>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/roster`,
  );
}

export async function loadInstructorResults(
  assignmentId: string,
): Promise<RuntimeInstructorResults> {
  return getJson<RuntimeInstructorResults>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/results`,
  );
}

export async function loadInstructorAssignmentReport(
  assignmentId: string,
): Promise<RuntimeInstructorAssignmentReport> {
  return getJson<RuntimeInstructorAssignmentReport>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/reporting`,
  );
}

export async function loadInstructorAssignmentReportCsv(
  assignmentId: string,
  type: "roster" | "items" | "standards",
): Promise<string> {
  const response = await fetch(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/reporting?format=csv&type=${encodeURIComponent(type)}`,
    {
      headers: await createRuntimeContextHeaders(),
    },
  );

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.text();
}

export async function loadInstructorReportExportCatalog(): Promise<RuntimeReportExportCatalog> {
  return getJson<RuntimeReportExportCatalog>("/api/instructor/report-exports/catalog");
}

export async function loadInstructorReportDataDictionaryCsv(): Promise<string> {
  const response = await fetch("/api/instructor/report-exports/data-dictionary?format=csv", {
    headers: await createRuntimeContextHeaders(),
  });

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.text();
}

export async function loadInstructorAssignmentReportBundle(assignmentId: string): Promise<Blob> {
  const response = await fetch(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/report-exports/bundle`,
    {
      headers: await createRuntimeContextHeaders(),
    },
  );

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.blob();
}

export async function loadInstructorLearnerReport(
  assignmentId: string,
  learnerId: string,
): Promise<RuntimeInstructorLearnerReport> {
  return getJson<RuntimeInstructorLearnerReport>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/learners/${encodeURIComponent(learnerId)}/report`,
  );
}

export async function loadInstructorLearnerReportCsv(
  assignmentId: string,
  learnerId: string,
  type: "items" | "evidence" | "attempts",
): Promise<string> {
  const response = await fetch(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/learners/${encodeURIComponent(learnerId)}/report?format=csv&type=${encodeURIComponent(type)}`,
    {
      headers: await createRuntimeContextHeaders(),
    },
  );

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.text();
}

export async function loadInstructorLearnerReportBundle(
  assignmentId: string,
  learnerId: string,
): Promise<Blob> {
  const response = await fetch(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/learners/${encodeURIComponent(learnerId)}/report-exports/bundle`,
    {
      headers: await createRuntimeContextHeaders(),
    },
  );

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.blob();
}

/** Read explicit assignment capabilities; unavailable reads are never inferred from HTTP failures. */
export async function loadInstructorAssignmentCapabilities(
  assignmentId: string,
): Promise<AssignmentStaffCapabilities> {
  const value = parseAssignmentStaffCapabilities(
    await getJson<unknown>(
      `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/capabilities`,
    ),
  );
  if (!value || value.assignmentId !== assignmentId)
    throw new RuntimeSessionError("Invalid staff capability response", 502);
  return value;
}

export async function loadScoreAmendments(
  assignmentId: string,
): Promise<RuntimeScoreAmendmentsResponse> {
  return getJson<RuntimeScoreAmendmentsResponse>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/score-amendments`,
  );
}

export async function loadManualScoringQueue(
  input: {
    assignmentId?: string;
  } = {},
): Promise<RuntimeManualScoringQueue> {
  const params = new URLSearchParams();
  if (input.assignmentId) {
    params.set("assignmentId", input.assignmentId);
  }
  const query = params.toString();
  return getJson<RuntimeManualScoringQueue>(
    query ? `/api/instructor/manual-scoring?${query}` : "/api/instructor/manual-scoring",
  );
}

export async function loadManualScoringAttempt(
  attemptId: string,
): Promise<RuntimeManualScoringAttempt> {
  return getJson<RuntimeManualScoringAttempt>(
    `/api/instructor/manual-scoring/attempts/${encodeURIComponent(attemptId)}`,
  );
}

export async function saveManualScore(input: {
  attemptId: string;
  itemId: string;
  request: SaveManualScoreRequest;
}): Promise<RuntimeSaveManualScoreResponse> {
  return putJson<RuntimeSaveManualScoreResponse>(
    `/api/instructor/manual-scoring/attempts/${encodeURIComponent(input.attemptId)}/items/${encodeURIComponent(input.itemId)}`,
    input.request,
  );
}

export async function finalizeManualScoringAttempt(input: {
  attemptId: string;
  request: FinalizeManualScoringRequest;
}): Promise<RuntimeFinalizeManualScoringResponse> {
  return postJson<RuntimeFinalizeManualScoringResponse>(
    `/api/instructor/manual-scoring/attempts/${encodeURIComponent(input.attemptId)}/finalize`,
    input.request,
  );
}

export async function createScoreAmendment(input: {
  assignmentId: string;
  request: CreateScoreAmendmentRequest;
}): Promise<RuntimeCreateScoreAmendmentResponse> {
  return postJson<RuntimeCreateScoreAmendmentResponse>(
    `/api/instructor/assignments/${encodeURIComponent(input.assignmentId)}/score-amendments`,
    input.request,
  );
}

export async function previewScoreAmendment(input: {
  assignmentId: string;
  request: CreateScoreAmendmentRequest;
}): Promise<RuntimeScoreAmendmentPreview> {
  return postJson<RuntimeScoreAmendmentPreview>(
    `/api/instructor/assignments/${encodeURIComponent(input.assignmentId)}/score-amendments/preview`,
    input.request,
  );
}

export async function deactivateScoreAmendment(input: {
  assignmentId: string;
  amendmentId: string;
  request: DeactivateScoreAmendmentRequest;
}): Promise<RuntimeDeactivateScoreAmendmentResponse> {
  return postJson<RuntimeDeactivateScoreAmendmentResponse>(
    `/api/instructor/assignments/${encodeURIComponent(input.assignmentId)}/score-amendments/${encodeURIComponent(input.amendmentId)}/deactivate`,
    input.request,
  );
}

export async function loadScoreAmendmentEvidenceExport(
  assignmentId: string,
): Promise<RuntimeScoreAmendmentEvidenceExport> {
  return getJson<RuntimeScoreAmendmentEvidenceExport>(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/score-amendments/export`,
  );
}

export async function loadScoreAmendmentEvidenceCsv(assignmentId: string): Promise<string> {
  const response = await fetch(
    `/api/instructor/assignments/${encodeURIComponent(assignmentId)}/score-amendments/export?format=csv`,
    {
      headers: await createRuntimeContextHeaders(),
    },
  );

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.text();
}

export async function loadResultsOpsRows(
  filters: RuntimeResultsOpsFilters = {},
): Promise<RuntimeResultsOpsResponse> {
  const params = new URLSearchParams();
  if (filters.tenantId) {
    params.set("tenantId", filters.tenantId);
  }
  if (filters.assignmentId) {
    params.set("assignmentId", filters.assignmentId);
  }

  const query = params.toString();
  return getJson<RuntimeResultsOpsResponse>(
    query ? `/api/instructor/results-ops?${query}` : "/api/instructor/results-ops",
  );
}

export async function requestResultsOpsRetry(input: {
  attemptId: string;
  request: RuntimeResultsOpsRetryRequest;
}): Promise<RuntimeResultsOpsRetryResponse> {
  return postJson<RuntimeResultsOpsRetryResponse>(
    `/api/instructor/results-ops/attempts/${encodeURIComponent(input.attemptId)}/retry`,
    input.request,
  );
}

export async function loadProvisioningRuns(): Promise<RuntimeProvisioningRuns> {
  return getJson<RuntimeProvisioningRuns>("/api/instructor/provisioning/runs");
}

export async function loadProvisioningRunDetail(
  runId: string,
): Promise<RuntimeProvisioningRunDetail> {
  return getJson<RuntimeProvisioningRunDetail>(
    `/api/instructor/provisioning/runs/${encodeURIComponent(runId)}`,
  );
}

export async function loadInstructorLmsWorkspace(): Promise<InstructorLmsWorkspaceResponse> {
  return getJson<InstructorLmsWorkspaceResponse>("/api/instructor/lms");
}

export function buildInstructorLmsEvidenceReportUrl(): string {
  return "/api/instructor/lms/evidence-report.csv";
}

export async function syncInstructorLmsNrps(input: {
  attemptId: string;
}): Promise<RuntimeInstructorLmsNrpsSync> {
  return postJson<RuntimeInstructorLmsNrpsSync>("/api/instructor/lms/nrps-sync", input);
}

export async function scheduleInstructorLmsNrps(input: {
  resourceLinkId: string;
  enabled: boolean;
  intervalMinutes?: number;
  reconciliationPolicy?: "additive-only" | "mark-inactive";
}): Promise<RuntimeInstructorLmsNrpsSchedule> {
  return postJson<RuntimeInstructorLmsNrpsSchedule>(
    `/api/instructor/lms/resource-links/${encodeURIComponent(input.resourceLinkId)}/nrps-schedule`,
    {
      enabled: input.enabled,
      intervalMinutes: input.intervalMinutes,
      reconciliationPolicy: input.reconciliationPolicy,
    },
  );
}

export async function previewRosterCsvImport(input: {
  sourceName?: string | null;
  csvText: string;
  actor: AssignmentActorSnapshot;
}): Promise<RuntimeRosterCsvImportResponse> {
  return postJson<RuntimeRosterCsvImportResponse>(
    "/api/instructor/provisioning/csv/preview",
    input,
  );
}

export async function applyRosterCsvImport(input: {
  sourceName?: string | null;
  csvText: string;
  actor: AssignmentActorSnapshot;
}): Promise<RuntimeRosterCsvImportResponse> {
  return postJson<RuntimeRosterCsvImportResponse>("/api/instructor/provisioning/csv/apply", input);
}

export async function previewOneRosterZipImport(input: {
  sourceName?: string | null;
  zipFile: File;
  actor: AssignmentActorSnapshot;
}): Promise<RuntimeRosterCsvImportResponse> {
  return postOneRosterZipImport("/api/instructor/provisioning/oneroster/preview", input);
}

export async function applyOneRosterZipImport(input: {
  sourceName?: string | null;
  zipFile: File;
  actor: AssignmentActorSnapshot;
}): Promise<RuntimeRosterCsvImportResponse> {
  return postOneRosterZipImport("/api/instructor/provisioning/oneroster/apply", input);
}

export async function saveAssignmentLearnerOverride(input: {
  assignmentId: string;
  learnerId: string;
  request: {
    actor: CreateAssignmentRequest["actor"];
    policyOverrides: AssignmentLearnerOverrideRecord["policyOverrides"];
    accommodations?: AssignmentLearnerOverrideRecord["accommodations"];
  };
}): Promise<RuntimeAssignmentLearnerOverride> {
  return putJson<RuntimeAssignmentLearnerOverride>(
    `/api/instructor/assignments/${encodeURIComponent(input.assignmentId)}/learners/${encodeURIComponent(input.learnerId)}/override`,
    input.request,
  );
}

export async function loadAccommodationProfiles(): Promise<RuntimeAccommodationProfilesResponse> {
  return getJson<RuntimeAccommodationProfilesResponse>("/api/instructor/accommodation-profiles");
}

export async function createAccommodationProfile(input: {
  tenantId: string;
  name: string;
  description?: string | null;
  status?: "draft" | "active" | "inactive";
  profile: HarborAccommodationProfileDefinition;
  actor: CreateAssignmentRequest["actor"];
}): Promise<RuntimeAccommodationProfile> {
  return postJson<RuntimeAccommodationProfile>("/api/instructor/accommodation-profiles", input);
}

export async function loadLearnerAccommodationAssignments(
  learnerId: string,
): Promise<RuntimeLearnerAccommodationAssignmentsResponse> {
  return getJson<RuntimeLearnerAccommodationAssignmentsResponse>(
    `/api/instructor/learners/${encodeURIComponent(learnerId)}/accommodation-profiles`,
  );
}

export async function saveLearnerAccommodationProfile(input: {
  learnerId: string;
  profileId: string;
  status?: "active" | "inactive";
}): Promise<RuntimeLearnerAccommodationAssignment> {
  return putJson<RuntimeLearnerAccommodationAssignment>(
    `/api/instructor/learners/${encodeURIComponent(input.learnerId)}/accommodation-profiles/${encodeURIComponent(input.profileId)}`,
    {
      status: input.status ?? "active",
      sourceKind: "instructor",
      effectiveAt: new Date().toISOString(),
    },
  );
}

export async function applyInstructorAttemptAction(input: {
  attemptId: string;
  action: OperatorAttemptActionRequest;
}): Promise<AttemptPolicyReadResponse> {
  return postJson<AttemptPolicyReadResponse>(
    `/api/instructor/attempts/${encodeURIComponent(input.attemptId)}/actions`,
    input.action,
  );
}

export async function loadInstructorAttemptTimeline(
  attemptId: string,
): Promise<RuntimeAttemptTimeline> {
  return getJson<RuntimeAttemptTimeline>(
    `/api/instructor/attempts/${encodeURIComponent(attemptId)}/timeline`,
  );
}

export async function loadInstructorAttemptEvidence(
  attemptId: string,
): Promise<RuntimeAttemptEvidence> {
  return getJson<RuntimeAttemptEvidence>(
    `/api/instructor/attempts/${encodeURIComponent(attemptId)}/evidence`,
  );
}

export async function logoutInstitutionalSession(): Promise<void> {
  await postJson<{ ok: boolean }>("/api/auth/logout", {});
}

export function beginInstitutionalLogin(input?: { redirectTo?: string; profile?: string }): void {
  const url = new URL("/api/auth/institutional/login", window.location.origin);
  url.searchParams.set("redirectTo", input?.redirectTo ?? window.location.pathname);
  if (input?.profile) {
    url.searchParams.set("profile", input.profile);
  }

  window.location.assign(url.toString());
}

export async function loadRuntimeShellContent(
  input: {
    attemptId: string;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<RuntimeShellContent> {
  const manifest = await loadRuntimeManifest(input.attemptId, options);
  const currentItem = await loadRuntimeItem(
    {
      attemptId: input.attemptId,
      itemId: manifest.currentItemId,
    },
    options,
  );

  return {
    manifest,
    currentItem,
  };
}

/** Refresh candidate-safe progress and current-item metadata after an adaptive receipt. */
export async function loadRuntimeManifest(
  attemptId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<RuntimeManifestSummary> {
  const manifest = await getJson<
    Omit<RuntimeManifestSummary, "assessmentInstructions"> & { assessmentInstructions?: unknown }
  >(`/api/content/manifest?attemptId=${encodeURIComponent(attemptId)}`, options);
  const instructions = parseAssessmentInstructionBlocks(
    manifest.assessmentInstructions === undefined ? [] : manifest.assessmentInstructions,
  );
  if (!instructions.ok)
    throw new RuntimeSessionError("Assessment instructions could not be loaded.", 409);
  return { ...manifest, assessmentInstructions: instructions.value };
}

export async function loadRuntimeItem(
  input: {
    attemptId: string;
    itemId: string;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<RuntimeItemPayload> {
  const attemptId = encodeURIComponent(input.attemptId);
  return getJson<RuntimeItemPayload>(
    `/api/content/items/${encodeURIComponent(input.itemId)}?attemptId=${attemptId}`,
    options,
  );
}

export async function exchangeRuntimeBootstrapToken(
  bootstrapToken: string,
  clientSessionId?: string,
): Promise<BootstrapPayload> {
  return postJson<BootstrapPayload>("/api/bootstrap", {
    bootstrapToken,
    clientSessionId,
  });
}

async function getJson<T>(
  path: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(path, {
    signal: options.signal,
    headers: await createRuntimeContextHeaders(),
  });

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const headers = await createRuntimeContextHeaders();
  headers.set("content-type", "application/json");
  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.json() as Promise<T>;
}

async function postOneRosterZipImport(
  path: string,
  input: {
    sourceName?: string | null;
    zipFile: File;
    actor: AssignmentActorSnapshot;
  },
): Promise<RuntimeRosterCsvImportResponse> {
  const headers = await createRuntimeContextHeaders();
  const body = new FormData();
  body.set("zip", input.zipFile);
  body.set("actor", JSON.stringify(input.actor));
  if (input.sourceName?.trim()) {
    body.set("sourceName", input.sourceName.trim());
  }

  const response = await fetch(path, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.json() as Promise<RuntimeRosterCsvImportResponse>;
}

async function putJson<T>(path: string, body: unknown): Promise<T> {
  const headers = await createRuntimeContextHeaders();
  headers.set("content-type", "application/json");
  const response = await fetch(path, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw await readRuntimeError(response);
  }

  return response.json() as Promise<T>;
}

async function readRuntimeError(response: Response): Promise<RuntimeSessionError> {
  let message = `${response.status} ${response.statusText}`;
  let deliveryContext: DeliveryContextEvaluation | null = null;

  try {
    const body = (await response.json()) as {
      error?: string;
      deliveryContext?: DeliveryContextEvaluation;
    };
    if (typeof body.error === "string" && body.error.trim()) {
      message = body.error;
    }
    if (body.deliveryContext && typeof body.deliveryContext === "object") {
      deliveryContext = body.deliveryContext;
    }
  } catch {
    // Fall back to status text when the response body is not JSON.
  }

  return new RuntimeSessionError(message, response.status, deliveryContext);
}

function sanitizeActor(actor: ActorInput | undefined): {
  id: string | null;
  displayName: string | null;
} {
  return {
    id: sanitizeOptionalString(actor?.id),
    displayName: sanitizeOptionalString(actor?.displayName),
  };
}

function sanitizeOptionalString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

let safeExamBrowserKeyUpdateUrl: string | null = null;
let safeExamBrowserKeyUpdatePromise: Promise<void> | null = null;

async function createRuntimeContextHeaders(): Promise<Headers> {
  const headers = new Headers();
  const evidence = await readDeliveryContextEvidence();

  headers.set(DELIVERY_CONTEXT_FRAME_MODE_HEADER, evidence.mode);
  if (evidence.embedOrigin) {
    headers.set(DELIVERY_CONTEXT_EMBED_ORIGIN_HEADER, evidence.embedOrigin);
  }
  if (evidence.secureBrowserProvider) {
    headers.set(DELIVERY_CONTEXT_SECURE_BROWSER_PROVIDER_HEADER, evidence.secureBrowserProvider);
  }
  if (evidence.safeExamBrowserConfigKeyHash) {
    headers.set(
      HARBOR_SAFE_EXAM_BROWSER_JS_CONFIG_KEY_HASH_HEADER,
      evidence.safeExamBrowserConfigKeyHash,
    );
  }
  if (evidence.safeExamBrowserRequestHash) {
    headers.set(
      HARBOR_SAFE_EXAM_BROWSER_JS_REQUEST_HASH_HEADER,
      evidence.safeExamBrowserRequestHash,
    );
  }
  if (evidence.safeExamBrowserProofUrl) {
    headers.set(HARBOR_SAFE_EXAM_BROWSER_JS_PROOF_URL_HEADER, evidence.safeExamBrowserProofUrl);
  }

  return headers;
}

async function readDeliveryContextEvidence(): Promise<{
  mode: "standalone" | "iframe";
  embedOrigin: string | null;
  secureBrowserProvider: string | null;
  safeExamBrowserConfigKeyHash: string | null;
  safeExamBrowserRequestHash: string | null;
  safeExamBrowserProofUrl: string | null;
}> {
  const mode = readFrameMode();
  const safeExamBrowserEvidence = await readSafeExamBrowserEvidence();

  return {
    mode,
    embedOrigin: mode === "iframe" ? readEmbedOrigin() : null,
    secureBrowserProvider: readSecureBrowserProvider(),
    safeExamBrowserConfigKeyHash: safeExamBrowserEvidence.configKeyHash,
    safeExamBrowserRequestHash: safeExamBrowserEvidence.browserExamKeyHash,
    safeExamBrowserProofUrl: safeExamBrowserEvidence.proofUrl,
  };
}

function readFrameMode(): "standalone" | "iframe" {
  if (typeof window === "undefined") {
    return "standalone";
  }

  try {
    return window.top === window.self ? "standalone" : "iframe";
  } catch {
    return "iframe";
  }
}

function readEmbedOrigin(): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  const referrer = sanitizeOptionalString(document.referrer);
  if (referrer) {
    try {
      return new URL(referrer).origin;
    } catch {
      return null;
    }
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.parent.location.origin;
  } catch {
    return null;
  }
}

function readSecureBrowserProvider(): string | null {
  if (typeof window !== "undefined") {
    const explicitProvider = sanitizeOptionalString(
      (
        window as Window & {
          __HARBOR_SECURE_BROWSER_PROVIDER__?: string;
        }
      ).__HARBOR_SECURE_BROWSER_PROVIDER__,
    );
    if (explicitProvider) {
      return explicitProvider;
    }
  }

  if (typeof navigator === "undefined") {
    return null;
  }

  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("safeexambrowser")) {
    return "safe-exam-browser";
  }

  return null;
}

async function readSafeExamBrowserEvidence(): Promise<{
  configKeyHash: string | null;
  browserExamKeyHash: string | null;
  proofUrl: string | null;
}> {
  if (typeof window === "undefined") {
    return {
      configKeyHash: null,
      browserExamKeyHash: null,
      proofUrl: null,
    };
  }

  const safeExamBrowser = (
    window as Window & {
      SafeExamBrowser?: {
        security?: {
          configKey?: string;
          browserExamKey?: string;
          updateKeys?: (callback?: () => void) => void;
        };
      };
    }
  ).SafeExamBrowser;
  const proofUrl = buildCurrentPageProofUrl();

  await updateSafeExamBrowserKeys(safeExamBrowser, proofUrl);

  return {
    configKeyHash: normalizeHash(safeExamBrowser?.security?.configKey),
    browserExamKeyHash: normalizeHash(safeExamBrowser?.security?.browserExamKey),
    proofUrl,
  };
}

async function updateSafeExamBrowserKeys(
  safeExamBrowser:
    | {
        security?: {
          updateKeys?: (callback?: () => void) => void;
        };
      }
    | undefined,
  proofUrl: string | null,
): Promise<void> {
  const security = safeExamBrowser?.security;
  const updateKeys = security?.updateKeys;
  if (typeof updateKeys !== "function" || !proofUrl) {
    return;
  }

  if (safeExamBrowserKeyUpdateUrl === proofUrl && safeExamBrowserKeyUpdatePromise) {
    return safeExamBrowserKeyUpdatePromise;
  }

  safeExamBrowserKeyUpdateUrl = proofUrl;
  safeExamBrowserKeyUpdatePromise = new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    window.setTimeout(finish, 500);
    try {
      updateKeys.call(security, finish);
    } catch {
      finish();
    }
  });

  return safeExamBrowserKeyUpdatePromise;
}

function buildCurrentPageProofUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const url = new URL(window.location.href);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeHash(value: string | null | undefined): string | null {
  const candidate = sanitizeOptionalString(value)?.toLowerCase();
  return candidate && /^[a-f0-9]{64}$/.test(candidate) ? candidate : null;
}

/** Fetch only the server-authorized projection, never private question XML or answer outcomes. */
export async function loadAnswerFeedback(
  attemptId: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<AnswerFeedbackResponse> {
  const value: unknown = await getJson(
    `/api/attempts/${encodeURIComponent(attemptId)}/feedback`,
    options,
  );
  const parsed = parseAnswerFeedbackResponse(value, attemptId);
  if (!parsed.ok) throw new RuntimeSessionError("Answer feedback could not be loaded.", 409);
  return parsed.value;
}
