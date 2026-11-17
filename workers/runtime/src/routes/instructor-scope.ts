/** Bindings needed to establish staff identity and explicit grants. */
export interface InstructorTenantEnv {
  HARBOR_DB: D1Database;
  BOOTSTRAP_SIGNING_SECRET?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_AUTH?: string;
  ALLOW_UNSAFE_LOCAL_INSTRUCTOR_TENANT_ID?: string;
}
