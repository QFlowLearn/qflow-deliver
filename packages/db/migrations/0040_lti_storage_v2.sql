-- Destructive cutover from legacy lti_tool_* tables to canonical lti_* schema.
-- No automatic data migration: re-register platforms or run a one-off ETL after applying.

DROP TABLE IF EXISTS lti_tool_sessions;
DROP TABLE IF EXISTS lti_tool_nonces;
DROP TABLE IF EXISTS lti_tool_registration_sessions;
DROP TABLE IF EXISTS lti_tool_deployments;
DROP TABLE IF EXISTS lti_tool_clients;

CREATE TABLE lti_clients (
  id text PRIMARY KEY NOT NULL,
  platform_name text NOT NULL,
  iss text NOT NULL,
  client_id text NOT NULL,
  auth_url text NOT NULL,
  token_url text NOT NULL,
  jwks_url text NOT NULL
);

CREATE INDEX lti_clients_issuer_client_idx ON lti_clients (client_id, iss);
CREATE UNIQUE INDEX lti_clients_iss_client_id_uniq ON lti_clients (iss, client_id);

CREATE TABLE lti_deployments (
  id text PRIMARY KEY NOT NULL,
  client_id text NOT NULL,
  deployment_id text NOT NULL,
  deployment_name text,
  deployment_description text,
  FOREIGN KEY (client_id) REFERENCES lti_clients(id) ON DELETE CASCADE
);

CREATE INDEX lti_deployments_deployment_id_idx ON lti_deployments (deployment_id);
CREATE UNIQUE INDEX lti_deployments_client_deployment_uniq ON lti_deployments (client_id, deployment_id);

CREATE TABLE lti_nonces (
  nonce text PRIMARY KEY NOT NULL,
  expires_at integer NOT NULL
);

CREATE INDEX lti_nonces_expires_at_idx ON lti_nonces (expires_at);

CREATE TABLE lti_registration_sessions (
  id text PRIMARY KEY NOT NULL,
  payload text NOT NULL,
  expires_at integer NOT NULL
);

CREATE INDEX lti_registration_sessions_expires_at_idx ON lti_registration_sessions (expires_at);

CREATE TABLE lti_sessions (
  id text PRIMARY KEY NOT NULL,
  payload text NOT NULL,
  expires_at integer NOT NULL
);

CREATE INDEX lti_sessions_expires_at_idx ON lti_sessions (expires_at);
