import {
  type InstructorAssignmentListItem,
  type InstructorAssignmentListResponse,
  type InstructorLearnersResponse,
  type InstructorPublishedAssessmentVersionListItem,
  type InstructorPublishedAssessmentVersionListResponse,
  type InstructorSectionsResponse,
} from "@harbor/attempt-protocol";
import { parseStoredAssignmentPolicySnapshot } from "../../assignment-request-parsers";
import { parseJsonStringArray, parseSectionStaff } from "./json-parsers";
import type {
  AssignmentListRow,
  LearnerListRow,
  PublishedAssessmentVersionListRow,
  SectionListRow,
} from "./types";

export async function readInstructorAssignmentList(input: {
  db: D1Database;
  tenantId: string;
}): Promise<InstructorAssignmentListResponse> {
  const rows = await input.db
    .prepare(
      `SELECT
         assignments.id AS assignment_id,
         assignments.assessment_id,
         assignments.assessment_version_id,
         assignments.title,
         assignments.status,
         assignments.policy_snapshot_json,
         assignments.created_at,
         assignments.updated_at,
         COALESCE(learner_targets.target_count, 0) AS learner_target_count,
         COALESCE(section_targets.target_count, 0) AS section_target_count
       FROM assignments
       LEFT JOIN (
         SELECT assignment_id, COUNT(*) AS target_count
         FROM assignment_learner_targets
         GROUP BY assignment_id
       ) learner_targets ON learner_targets.assignment_id = assignments.id
       LEFT JOIN (
         SELECT assignment_id, COUNT(*) AS target_count
         FROM assignment_section_targets
         GROUP BY assignment_id
       ) section_targets ON section_targets.assignment_id = assignments.id
       INNER JOIN assessments
         ON assessments.id = assignments.assessment_id
        AND assessments.tenant_id = ?
       ORDER BY assignments.updated_at DESC, assignments.id DESC`,
    )
    .bind(input.tenantId)
    .all<AssignmentListRow>();

  const assignments: InstructorAssignmentListItem[] = rows.results.map((row) => {
    const policy = parseStoredAssignmentPolicySnapshot(row.policy_snapshot_json);
    return {
      assignmentId: row.assignment_id,
      assessmentId: row.assessment_id,
      assessmentVersionId: row.assessment_version_id,
      title: row.title,
      status: row.status,
      availableFrom: policy.availableFrom,
      availableUntil: policy.availableUntil,
      learnerTargetCount: row.learner_target_count,
      sectionTargetCount: row.section_target_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  return { assignments };
}

export async function readInstructorPublishedAssessmentVersions(input: {
  db: D1Database;
  tenantId: string;
}): Promise<InstructorPublishedAssessmentVersionListResponse> {
  const rows = await input.db
    .prepare(
      `SELECT
         assessments.id AS assessment_id,
         assessments.title AS assessment_title,
         assessments.slug AS assessment_slug,
         assessment_versions.id AS assessment_version_id,
         assessment_versions.version_number,
         assessment_versions.created_at
       FROM assessment_versions
       INNER JOIN assessments
         ON assessments.id = assessment_versions.assessment_id
        AND assessments.tenant_id = ?
       ORDER BY assessment_versions.created_at DESC, assessment_versions.id DESC`,
    )
    .bind(input.tenantId)
    .all<PublishedAssessmentVersionListRow>();

  const versions: InstructorPublishedAssessmentVersionListItem[] = rows.results.map((row) => ({
    assessmentId: row.assessment_id,
    assessmentTitle: row.assessment_title,
    assessmentSlug: row.assessment_slug,
    assessmentVersionId: row.assessment_version_id,
    versionNumber: row.version_number,
    createdAt: row.created_at,
  }));

  return { versions };
}

export async function readInstructorSections(input: {
  db: D1Database;
  tenantId: string;
}): Promise<InstructorSectionsResponse> {
  const rows = await input.db
    .prepare(
      `SELECT
         sections.id,
         sections.tenant_id,
         sections.source_kind,
         sections.source_id,
         sections.title,
         sections.created_at,
         sections.updated_at,
         COALESCE(active_memberships.active_learner_count, 0) AS active_learner_count,
         metadata.source_id AS provisioning_source_id,
         metadata.class_sourced_id,
         metadata.course_sourced_id,
         courses.title AS course_title,
         metadata.school_sourced_id,
         schools.name AS school_name,
         metadata.term_sourced_ids_json,
         (
           SELECT json_group_array(sessions.title)
           FROM provisioning_academic_sessions sessions
           WHERE sessions.source_id = metadata.source_id
             AND EXISTS (
               SELECT 1
               FROM json_each(metadata.term_sourced_ids_json)
               WHERE json_each.value = sessions.sourced_id
             )
         ) AS term_titles_json,
         metadata.class_code,
         metadata.class_type,
         (
           SELECT json_group_array(
             json_object(
               'sourcedId', staff_users.sourced_id,
               'displayName', staff_users.display_name,
               'email', staff_users.email,
               'role', class_staff.role
             )
           )
           FROM provisioning_class_staff class_staff
           INNER JOIN provisioning_staff_users staff_users
             ON staff_users.source_id = class_staff.source_id
            AND staff_users.sourced_id = class_staff.staff_sourced_id
           WHERE class_staff.section_id = sections.id
             AND class_staff.status = 'active'
         ) AS staff_json
       FROM sections
       LEFT JOIN (
         SELECT section_id, COUNT(*) AS active_learner_count
         FROM section_memberships
         WHERE status = ?
         GROUP BY section_id
       ) active_memberships ON active_memberships.section_id = sections.id
       LEFT JOIN provisioning_section_metadata metadata
         ON metadata.section_id = sections.id
        AND metadata.tenant_id = sections.tenant_id
       LEFT JOIN provisioning_courses courses
         ON courses.source_id = metadata.source_id
        AND courses.sourced_id = metadata.course_sourced_id
       LEFT JOIN provisioning_orgs schools
         ON schools.source_id = metadata.source_id
        AND schools.sourced_id = metadata.school_sourced_id
       WHERE sections.tenant_id = ?
       ORDER BY sections.title ASC, sections.source_id ASC
       LIMIT 200`,
    )
    .bind("active", input.tenantId)
    .all<SectionListRow>();

  return {
    sections: rows.results.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      sourceKind: row.source_kind,
      sourceId: row.source_id,
      title: row.title,
      activeLearnerCount: row.active_learner_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      provisioningMetadata: row.class_sourced_id
        ? {
            sourceId: row.provisioning_source_id ?? "",
            classSourcedId: row.class_sourced_id,
            courseSourcedId: row.course_sourced_id,
            courseTitle: row.course_title,
            schoolSourcedId: row.school_sourced_id,
            schoolName: row.school_name,
            termSourcedIds: row.term_sourced_ids_json
              ? parseJsonStringArray(row.term_sourced_ids_json)
              : [],
            termTitles: row.term_titles_json ? parseJsonStringArray(row.term_titles_json) : [],
            classCode: row.class_code,
            classType: row.class_type,
            staff: row.staff_json ? parseSectionStaff(row.staff_json) : [],
          }
        : null,
    })),
  };
}

export async function readInstructorLearners(input: {
  db: D1Database;
  tenantId: string;
  search: string | null;
  learnerIds: string[];
}): Promise<InstructorLearnersResponse> {
  const searchTerm = input.search?.trim() ?? "";
  const learnerIds = [...new Set(input.learnerIds.map((id) => id.trim()).filter(Boolean))];
  const matchConditions: string[] = [];
  const bindings: unknown[] = [input.tenantId, "active", input.tenantId];

  if (searchTerm) {
    const like = `%${searchTerm}%`;
    matchConditions.push(
      "(learners.id LIKE ? OR learners.display_name LIKE ? OR learners.email LIKE ?)",
    );
    bindings.push(like, like, like);
  }

  if (learnerIds.length > 0) {
    matchConditions.push(`learners.id IN (${learnerIds.map(() => "?").join(", ")})`);
    bindings.push(...learnerIds);
  }

  if (!searchTerm && learnerIds.length === 0) {
    return { learners: [] };
  }

  const rows = await input.db
    .prepare(
      `SELECT
         learners.id,
         learners.tenant_id,
         learners.display_name,
         learners.email,
         learners.created_at,
         learners.updated_at,
         COALESCE(active_memberships.active_section_count, 0) AS active_section_count
       FROM harbor_learners learners
       LEFT JOIN (
         SELECT section_memberships.learner_id, COUNT(*) AS active_section_count
         FROM section_memberships
         INNER JOIN sections
           ON sections.id = section_memberships.section_id
          AND sections.tenant_id = ?
         WHERE section_memberships.status = ?
         GROUP BY section_memberships.learner_id
       ) active_memberships ON active_memberships.learner_id = learners.id
       WHERE learners.tenant_id = ? AND (${matchConditions.join(" OR ")})
       ORDER BY learners.display_name ASC, learners.id ASC
       LIMIT 50`,
    )
    .bind(...bindings)
    .all<LearnerListRow>();

  return {
    learners: rows.results.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      displayName: row.display_name,
      email: row.email,
      activeSectionCount: row.active_section_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}
