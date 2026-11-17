import { createLtiId } from "./ids";

export async function ensureLaunchSectionMembership(input: {
  db: D1Database;
  learnerId: string;
  sectionId: string;
  role?: string;
  status?: string;
}): Promise<void> {
  const now = new Date().toISOString();
  await input.db
    .prepare(
      "INSERT INTO section_memberships (id, section_id, learner_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(section_id, learner_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
    )
    .bind(
      createLtiId("membership"),
      input.sectionId,
      input.learnerId,
      input.role ?? "learner",
      input.status ?? "active",
      now,
      now,
    )
    .run();
}
