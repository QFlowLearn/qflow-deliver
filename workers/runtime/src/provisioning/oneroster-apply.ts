import type {
  OneRosterCategoryRecord,
  OneRosterClassRecord,
  OneRosterClassResourceRecord,
  OneRosterCourseResourceRecord,
  OneRosterCsvFullPackage,
  OneRosterCsvValidatedFullPackage,
  OneRosterEnrollmentRecord,
  OneRosterLineItemRecord,
  OneRosterResourceRecord,
  OneRosterResultRecord,
  OneRosterScoreScaleRecord,
  OneRosterUserRecord,
} from "@longsightgroup/oneroster";
import {
  formatOneRosterUserDisplayName,
  getFirstActiveOneRosterResultScoreScale,
  getOneRosterRecordStatus,
  getOneRosterUserStatus,
  oneRosterRecordToCsvObject,
  summarizeOneRosterCsvFullPackage,
} from "@longsightgroup/oneroster";
import type { ProvisioningSourceRecord, RosterProvisioningSummary } from "@harbor/attempt-protocol";

type OneRosterHierarchySummary = Required<
  Pick<
    RosterProvisioningSummary,
    | "orgUpsertCount"
    | "academicSessionUpsertCount"
    | "courseUpsertCount"
    | "classMetadataUpsertCount"
    | "staffUserUpsertCount"
    | "classStaffUpsertCount"
    | "resourceUpsertCount"
    | "classResourceUpsertCount"
    | "courseResourceUpsertCount"
    | "gradebookCategoryUpsertCount"
    | "gradebookLineItemUpsertCount"
    | "gradebookScoreScaleUpsertCount"
    | "gradebookResultUpsertCount"
  >
>;

interface PlannedSection {
  readonly externalId: string;
  readonly harborId: string;
}

interface PlannedSectionMetadata {
  readonly classRecord: OneRosterClassRecord;
  readonly sectionId: string;
}

interface PlannedClassStaff {
  readonly staffAssignment: OneRosterEnrollmentRecord;
  readonly sectionId: string;
}

/** Apply-ready OneRoster hierarchy records and counts derived from planned roster sections. */
export interface OneRosterHierarchyPlan {
  readonly summary: OneRosterHierarchySummary;
  readonly staffUsers: readonly OneRosterUserRecord[];
  readonly sectionMetadata: readonly PlannedSectionMetadata[];
  readonly classStaffAssignments: readonly PlannedClassStaff[];
}

interface StatementContext {
  readonly db: D1Database;
  readonly tenantId: string;
  readonly source: ProvisioningSourceRecord;
  readonly now: string;
}

/** Build OneRoster hierarchy persistence inputs and matching summary counts without writing. */
export function planOneRosterHierarchy(input: {
  validatedPackage: OneRosterCsvValidatedFullPackage;
  sections: PlannedSection[];
}): OneRosterHierarchyPlan {
  const fullPackage = input.validatedPackage.fullPackage;
  const packageSummary = summarizeOneRosterCsvFullPackage(input.validatedPackage);
  const rostering = fullPackage.rosteringPackage;
  const sectionIdByClassSourcedId = new Map(
    input.sections.map((section) => [section.externalId, section.harborId]),
  );
  const usersBySourcedId = new Map(rostering.users.map((user) => [user.sourcedId, user]));
  const staffUsers = staffUsersFromEnrollments(rostering.enrollments, usersBySourcedId);
  const sectionMetadata = planSectionMetadata(rostering.classes, sectionIdByClassSourcedId);
  const classStaffAssignments = planClassStaffAssignments(
    rostering.enrollments,
    sectionIdByClassSourcedId,
  );

  return {
    summary: {
      orgUpsertCount: packageSummary.tables.orgs,
      academicSessionUpsertCount: packageSummary.tables.academicSessions,
      courseUpsertCount: packageSummary.tables.courses,
      classMetadataUpsertCount: sectionMetadata.length,
      staffUserUpsertCount: staffUsers.length,
      classStaffUpsertCount: classStaffAssignments.length,
      resourceUpsertCount: packageSummary.tables.resources,
      classResourceUpsertCount: packageSummary.tables.classResources,
      courseResourceUpsertCount: packageSummary.tables.courseResources,
      gradebookCategoryUpsertCount: packageSummary.tables.categories,
      gradebookLineItemUpsertCount: packageSummary.tables.lineItems,
      gradebookScoreScaleUpsertCount: packageSummary.tables.scoreScales,
      gradebookResultUpsertCount: packageSummary.tables.results,
    },
    staffUsers,
    sectionMetadata,
    classStaffAssignments,
  };
}

/** Persist a previously planned OneRoster hierarchy projection. */
export async function applyOneRosterHierarchy(input: {
  db: D1Database;
  tenantId: string;
  source: ProvisioningSourceRecord;
  validatedPackage: OneRosterCsvValidatedFullPackage;
  hierarchyPlan: OneRosterHierarchyPlan;
}): Promise<void> {
  const now = new Date().toISOString();
  const context: StatementContext = {
    db: input.db,
    tenantId: input.tenantId,
    source: input.source,
    now,
  };
  const fullPackage = input.validatedPackage.fullPackage;
  const rostering = fullPackage.rosteringPackage;
  const gradebook = fullPackage.gradebookPackage;
  const resources = fullPackage.resourcesPackage;
  const statements = [
    ...orgStatements(context, rostering.orgs),
    ...academicSessionStatements(context, rostering.academicSessions),
    ...courseStatements(context, rostering.courses),
    ...staffUserStatements(context, input.hierarchyPlan.staffUsers),
    ...resourceStatements(context, resources.resources),
    ...classResourceStatements(context, resources.classResources),
    ...courseResourceStatements(context, resources.courseResources),
    ...categoryStatements(context, gradebook.categories),
    ...lineItemStatements(context, gradebook.lineItems),
    ...scoreScaleStatements(context, gradebook.scoreScales),
    ...resultStatements(context, input.validatedPackage, gradebook.results),
    ...sectionMetadataStatements(context, input.hierarchyPlan.sectionMetadata),
    ...classStaffStatements(context, input.hierarchyPlan.classStaffAssignments),
  ];

  if (statements.length > 0) {
    await input.db.batch(statements);
  }
}

function planSectionMetadata(
  classes: readonly OneRosterClassRecord[],
  sectionIdByClassSourcedId: ReadonlyMap<string, string>,
): PlannedSectionMetadata[] {
  return classes.flatMap((classRecord) => {
    const sectionId = sectionIdByClassSourcedId.get(classRecord.sourcedId);
    return sectionId === undefined ? [] : [{ classRecord, sectionId }];
  });
}

function planClassStaffAssignments(
  enrollments: readonly OneRosterEnrollmentRecord[],
  sectionIdByClassSourcedId: ReadonlyMap<string, string>,
): PlannedClassStaff[] {
  return enrollments.flatMap((staffAssignment) => {
    if (staffAssignment.role === "student") {
      return [];
    }
    const sectionId = sectionIdByClassSourcedId.get(staffAssignment.classSourcedId);
    return sectionId === undefined ? [] : [{ staffAssignment, sectionId }];
  });
}

function orgStatements(
  context: StatementContext,
  orgs: OneRosterCsvFullPackage["rosteringPackage"]["orgs"],
): D1PreparedStatement[] {
  return orgs.map((org) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_orgs (id, tenant_id, source_id, sourced_id, name, org_type, identifier, parent_sourced_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET name = excluded.name, org_type = excluded.org_type, identifier = excluded.identifier, parent_sourced_id = excluded.parent_sourced_id, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("porg"),
        context.tenantId,
        context.source.id,
        org.sourcedId,
        org.name,
        org.type,
        org.identifier ?? null,
        org.parentSourcedId ?? null,
        getOneRosterRecordStatus(org),
        context.now,
        context.now,
      ),
  );
}

function academicSessionStatements(
  context: StatementContext,
  sessions: OneRosterCsvFullPackage["rosteringPackage"]["academicSessions"],
): D1PreparedStatement[] {
  return sessions.map((session) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_academic_sessions (id, tenant_id, source_id, sourced_id, title, session_type, start_date, end_date, parent_sourced_id, school_year, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET title = excluded.title, session_type = excluded.session_type, start_date = excluded.start_date, end_date = excluded.end_date, parent_sourced_id = excluded.parent_sourced_id, school_year = excluded.school_year, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pasn"),
        context.tenantId,
        context.source.id,
        session.sourcedId,
        session.title,
        session.type,
        session.startDate,
        session.endDate,
        session.parentSourcedId ?? null,
        session.schoolYear,
        getOneRosterRecordStatus(session),
        context.now,
        context.now,
      ),
  );
}

function courseStatements(
  context: StatementContext,
  courses: OneRosterCsvFullPackage["rosteringPackage"]["courses"],
): D1PreparedStatement[] {
  return courses.map((course) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_courses (id, tenant_id, source_id, sourced_id, title, course_code, org_sourced_id, school_year_sourced_id, grades_json, subjects_json, subject_codes_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET title = excluded.title, course_code = excluded.course_code, org_sourced_id = excluded.org_sourced_id, school_year_sourced_id = excluded.school_year_sourced_id, grades_json = excluded.grades_json, subjects_json = excluded.subjects_json, subject_codes_json = excluded.subject_codes_json, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pcrs"),
        context.tenantId,
        context.source.id,
        course.sourcedId,
        course.title,
        course.courseCode ?? null,
        course.orgSourcedId,
        course.schoolYearSourcedId ?? null,
        JSON.stringify(course.grades),
        JSON.stringify(course.subjects),
        JSON.stringify(course.subjectCodes),
        getOneRosterRecordStatus(course),
        context.now,
        context.now,
      ),
  );
}

function staffUserStatements(
  context: StatementContext,
  staffUsers: readonly OneRosterUserRecord[],
): D1PreparedStatement[] {
  return staffUsers.map((staffUser) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_staff_users (id, tenant_id, source_id, sourced_id, display_name, email, username, identifier, primary_org_sourced_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET display_name = excluded.display_name, email = excluded.email, username = excluded.username, identifier = excluded.identifier, primary_org_sourced_id = excluded.primary_org_sourced_id, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pstu"),
        context.tenantId,
        context.source.id,
        staffUser.sourcedId,
        formatOneRosterUserDisplayName(staffUser),
        staffUser.email ?? null,
        staffUser.username || null,
        staffUser.identifier ?? null,
        staffUser.primaryOrgSourcedId ?? null,
        getOneRosterUserStatus(staffUser),
        context.now,
        context.now,
      ),
  );
}

function resourceStatements(
  context: StatementContext,
  resources: readonly OneRosterResourceRecord[],
): D1PreparedStatement[] {
  return resources.map((resource) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_resources (id, tenant_id, source_id, sourced_id, title, vendor_resource_id, resource_type, roles_json, importance, vendor_id, application_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET title = excluded.title, vendor_resource_id = excluded.vendor_resource_id, resource_type = excluded.resource_type, roles_json = excluded.roles_json, importance = excluded.importance, vendor_id = excluded.vendor_id, application_id = excluded.application_id, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pres"),
        context.tenantId,
        context.source.id,
        resource.sourcedId,
        resource.title ?? resource.vendorResourceId,
        resource.vendorResourceId,
        resource.metadata.resourceType ?? null,
        JSON.stringify(resource.roles),
        resource.importance ?? null,
        resource.vendorId ?? null,
        resource.applicationId ?? null,
        getOneRosterRecordStatus(resource),
        context.now,
        context.now,
      ),
  );
}

function classResourceStatements(
  context: StatementContext,
  assignments: readonly OneRosterClassResourceRecord[],
): D1PreparedStatement[] {
  return assignments.map((assignment) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_class_resources (id, tenant_id, source_id, class_sourced_id, resource_sourced_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, class_sourced_id, resource_sourced_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pcrl"),
        context.tenantId,
        context.source.id,
        assignment.classSourcedId,
        assignment.resourceSourcedId,
        getOneRosterRecordStatus(assignment),
        context.now,
        context.now,
      ),
  );
}

function courseResourceStatements(
  context: StatementContext,
  assignments: readonly OneRosterCourseResourceRecord[],
): D1PreparedStatement[] {
  return assignments.map((assignment) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_course_resources (id, tenant_id, source_id, course_sourced_id, resource_sourced_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, course_sourced_id, resource_sourced_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pcor"),
        context.tenantId,
        context.source.id,
        assignment.courseSourcedId,
        assignment.resourceSourcedId,
        getOneRosterRecordStatus(assignment),
        context.now,
        context.now,
      ),
  );
}

function categoryStatements(
  context: StatementContext,
  categories: readonly OneRosterCategoryRecord[],
): D1PreparedStatement[] {
  return categories.map((category) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_gradebook_categories (id, tenant_id, source_id, sourced_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET title = excluded.title, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pgbc"),
        context.tenantId,
        context.source.id,
        category.sourcedId,
        category.title,
        getOneRosterRecordStatus(category),
        context.now,
        context.now,
      ),
  );
}

function lineItemStatements(
  context: StatementContext,
  lineItems: readonly OneRosterLineItemRecord[],
): D1PreparedStatement[] {
  return lineItems.map((lineItem) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_gradebook_line_items (id, tenant_id, source_id, sourced_id, title, description, assign_date, due_date, class_sourced_id, school_sourced_id, category_sourced_id, result_value_min, result_value_max, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET title = excluded.title, description = excluded.description, assign_date = excluded.assign_date, due_date = excluded.due_date, class_sourced_id = excluded.class_sourced_id, school_sourced_id = excluded.school_sourced_id, category_sourced_id = excluded.category_sourced_id, result_value_min = excluded.result_value_min, result_value_max = excluded.result_value_max, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pgbl"),
        context.tenantId,
        context.source.id,
        lineItem.sourcedId,
        lineItem.title,
        lineItem.description ?? null,
        lineItem.assignDate,
        lineItem.dueDate,
        lineItem.classSourcedId,
        lineItem.schoolSourcedId,
        lineItem.categorySourcedId,
        formatOptionalNumber(lineItem.resultValueMin),
        formatOptionalNumber(lineItem.resultValueMax),
        getOneRosterRecordStatus(lineItem),
        context.now,
        context.now,
      ),
  );
}

function scoreScaleStatements(
  context: StatementContext,
  scoreScales: readonly OneRosterScoreScaleRecord[],
): D1PreparedStatement[] {
  return scoreScales.map((scoreScale) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_gradebook_score_scales (id, tenant_id, source_id, sourced_id, title, status, raw_row_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET title = excluded.title, status = excluded.status, raw_row_json = excluded.raw_row_json, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pgbs"),
        context.tenantId,
        context.source.id,
        scoreScale.sourcedId,
        scoreScale.title,
        getOneRosterRecordStatus(scoreScale),
        JSON.stringify(oneRosterRecordToCsvObject("scoreScales.csv", scoreScale)),
        context.now,
        context.now,
      ),
  );
}

function resultStatements(
  context: StatementContext,
  validatedPackage: OneRosterCsvValidatedFullPackage,
  results: readonly OneRosterResultRecord[],
): D1PreparedStatement[] {
  return results.map((result) => {
    const scoreScaleSourcedId = scoreScaleSourcedIdForResult(validatedPackage, result);
    const rawRow = {
      ...oneRosterRecordToCsvObject("results.csv", result),
      scoreScaleSourcedId: scoreScaleSourcedId ?? "",
    };
    return context.db
      .prepare(
        "INSERT INTO provisioning_gradebook_results (id, tenant_id, source_id, sourced_id, line_item_sourced_id, student_sourced_id, score, text_score, score_status, score_date, score_scale_sourced_id, comment, status, raw_row_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, sourced_id) DO UPDATE SET line_item_sourced_id = excluded.line_item_sourced_id, student_sourced_id = excluded.student_sourced_id, score = excluded.score, text_score = excluded.text_score, score_status = excluded.score_status, score_date = excluded.score_date, score_scale_sourced_id = excluded.score_scale_sourced_id, comment = excluded.comment, status = excluded.status, raw_row_json = excluded.raw_row_json, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pgbr"),
        context.tenantId,
        context.source.id,
        result.sourcedId,
        result.lineItemSourcedId,
        result.studentSourcedId,
        formatOptionalNumber(result.score),
        result.textScore ?? null,
        result.scoreStatus,
        result.scoreDate,
        scoreScaleSourcedId,
        result.comment ?? null,
        getOneRosterRecordStatus(result),
        JSON.stringify(rawRow),
        context.now,
        context.now,
      );
  });
}

function sectionMetadataStatements(
  context: StatementContext,
  sectionMetadata: readonly PlannedSectionMetadata[],
): D1PreparedStatement[] {
  return sectionMetadata.map(({ classRecord, sectionId }) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_section_metadata (id, tenant_id, source_id, section_id, class_sourced_id, course_sourced_id, school_sourced_id, term_sourced_ids_json, class_code, class_type, location, grades_json, subjects_json, subject_codes_json, periods_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, class_sourced_id) DO UPDATE SET section_id = excluded.section_id, course_sourced_id = excluded.course_sourced_id, school_sourced_id = excluded.school_sourced_id, term_sourced_ids_json = excluded.term_sourced_ids_json, class_code = excluded.class_code, class_type = excluded.class_type, location = excluded.location, grades_json = excluded.grades_json, subjects_json = excluded.subjects_json, subject_codes_json = excluded.subject_codes_json, periods_json = excluded.periods_json, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("psmd"),
        context.tenantId,
        context.source.id,
        sectionId,
        classRecord.sourcedId,
        classRecord.courseSourcedId,
        classRecord.schoolSourcedId,
        JSON.stringify(classRecord.termSourcedIds),
        classRecord.classCode ?? null,
        classRecord.classType,
        classRecord.location ?? null,
        JSON.stringify(classRecord.grades),
        JSON.stringify(classRecord.subjects),
        JSON.stringify(classRecord.subjectCodes),
        JSON.stringify(classRecord.periods),
        getOneRosterRecordStatus(classRecord),
        context.now,
        context.now,
      ),
  );
}

function classStaffStatements(
  context: StatementContext,
  classStaffAssignments: readonly PlannedClassStaff[],
): D1PreparedStatement[] {
  return classStaffAssignments.map(({ staffAssignment, sectionId }) =>
    context.db
      .prepare(
        "INSERT INTO provisioning_class_staff (id, tenant_id, source_id, section_id, class_sourced_id, staff_sourced_id, enrollment_sourced_id, role, primary_flag, begin_date, end_date, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, class_sourced_id, staff_sourced_id, role) DO UPDATE SET section_id = excluded.section_id, enrollment_sourced_id = excluded.enrollment_sourced_id, primary_flag = excluded.primary_flag, begin_date = excluded.begin_date, end_date = excluded.end_date, status = excluded.status, updated_at = excluded.updated_at",
      )
      .bind(
        createId("pcst"),
        context.tenantId,
        context.source.id,
        sectionId,
        staffAssignment.classSourcedId,
        staffAssignment.userSourcedId,
        staffAssignment.sourcedId,
        staffAssignment.role,
        formatBoolean(staffAssignment.primary),
        staffAssignment.beginDate ?? null,
        staffAssignment.endDate ?? null,
        getOneRosterRecordStatus(staffAssignment),
        context.now,
        context.now,
      ),
  );
}

function staffUsersFromEnrollments(
  enrollments: readonly OneRosterEnrollmentRecord[],
  usersBySourcedId: ReadonlyMap<string, OneRosterUserRecord>,
): OneRosterUserRecord[] {
  const staffUsers = new Map<string, OneRosterUserRecord>();
  for (const enrollment of enrollments) {
    if (enrollment.role === "student") {
      continue;
    }
    const staffUser = usersBySourcedId.get(enrollment.userSourcedId);
    if (staffUser !== undefined) {
      staffUsers.set(staffUser.sourcedId, staffUser);
    }
  }
  return [...staffUsers.values()];
}

function scoreScaleSourcedIdForResult(
  validatedPackage: OneRosterCsvValidatedFullPackage,
  result: OneRosterResultRecord,
): string | null {
  return (
    getFirstActiveOneRosterResultScoreScale(validatedPackage, result)?.scoreScale.sourcedId ?? null
  );
}

function formatBoolean(value: boolean | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return value ? "true" : "false";
}

function formatOptionalNumber(value: number | undefined): string | null {
  return value === undefined ? null : String(value);
}

function createId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
