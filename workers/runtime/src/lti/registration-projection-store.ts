import type { LTIClient, LTIDeployment } from "@longsightgroup/lti-tool";

import { createLtiId } from "./ids";
import { LtiRegistrationError } from "./registration-error";
import type { HarborRegistrationPersistInput } from "./types";

const REGISTRATION_TENANT_CONFLICT_MARKER = "lti_registration_tenant_conflict";

const REGISTRATION_UPSERT_SQL = `INSERT INTO lti_registrations
  (id, tenant_id, issuer, client_id, deployment_id, authorization_endpoint, token_endpoint, jwks_url, created_at, updated_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
 ON CONFLICT(issuer, client_id, deployment_id) DO UPDATE SET
   tenant_id = excluded.tenant_id,
   authorization_endpoint = excluded.authorization_endpoint,
   token_endpoint = excluded.token_endpoint,
   jwks_url = excluded.jwks_url,
   updated_at = excluded.updated_at
 RETURNING id`;

interface ExistingProjection {
  readonly id: string;
  readonly tenant_id: string;
  readonly issuer: string;
  readonly client_id: string;
  readonly deployment_id: string;
}

/** A protocol registration projected into Harbor's tenant-owned control plane. */
export interface DiscoveredRegistrationProjection {
  readonly issuer: string;
  readonly clientId: string;
  readonly deploymentId: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUrl: string;
}

/** Counts returned after an atomic tenant projection reconciliation. */
export interface RegistrationProjectionReconcileResult {
  readonly discoveredCount: number;
  readonly missingCount: number;
  readonly alreadyPresentCount: number;
}

/**
 * Owns Harbor registration projection persistence and tenant-ownership enforcement.
 *
 * Conflict updates pass the requested owner through the immutable tenant trigger. A cross-tenant
 * race therefore aborts the entire D1 batch instead of becoming a successful no-op.
 */
export class D1RegistrationProjectionStore {
  constructor(private readonly database: D1Database) {}

  /** Creates or refreshes one projection without allowing its tenant owner to change. */
  async upsert(input: HarborRegistrationPersistInput): Promise<string> {
    const discovered = [toDiscoveredProjection(input)];
    await this.readExistingForTenant(input.tenantId, discovered);

    let row: { id: string } | null;
    try {
      row = await this.prepareUpsert(input, new Date().toISOString()).first<{ id: string }>();
    } catch (cause: unknown) {
      throwRegistrationTenantConflict(cause);
    }
    if (!row) {
      throw new Error("LTI registration projection upsert returned no row");
    }
    return row.id;
  }

  /** Atomically reconciles every discovered package registration for one tenant. */
  async reconcile(
    tenantId: string,
    discovered: ReadonlyArray<DiscoveredRegistrationProjection>,
  ): Promise<RegistrationProjectionReconcileResult> {
    const existing = await this.readExistingForTenant(tenantId, discovered);
    if (discovered.length === 0) {
      return { discoveredCount: 0, missingCount: 0, alreadyPresentCount: 0 };
    }

    const now = new Date().toISOString();
    const statements = discovered.map((registration) => {
      const current = existing.get(
        projectionKey(registration.issuer, registration.clientId, registration.deploymentId),
      );
      return this.prepareUpsert(
        {
          registrationId: current?.id ?? createLtiId("ltireg"),
          tenantId,
          issuer: registration.issuer,
          clientId: registration.clientId,
          deploymentId: registration.deploymentId,
          authorizationEndpoint: registration.authorizationEndpoint,
          tokenEndpoint: registration.tokenEndpoint,
          jwksUrl: registration.jwksUrl,
        },
        now,
      );
    });

    try {
      await this.database.batch(statements);
    } catch (cause: unknown) {
      throwRegistrationTenantConflict(cause);
    }
    await this.assertProjectionsPresent(tenantId, discovered);

    return {
      discoveredCount: discovered.length,
      missingCount: discovered.length - existing.size,
      alreadyPresentCount: existing.size,
    };
  }

  /** Discovers tenant-scoped protocol registrations and reconciles Harbor projections. */
  async reconcileFromProtocolStorage(
    tenantId: string,
    storage: ProtocolRegistrationDiscoverySource,
  ): Promise<RegistrationProjectionReconcileResult> {
    const clients = await storage.listClients();
    const deployments = await Promise.all(
      clients.map(async (client) => ({
        client,
        deployments: await storage.listDeployments(client.id),
      })),
    );
    const discovered = new Map<string, DiscoveredRegistrationProjection>();

    for (const entry of deployments) {
      for (const deployment of entry.deployments) {
        const registration = {
          issuer: entry.client.iss,
          clientId: entry.client.clientId,
          deploymentId: deployment.deploymentId,
          authorizationEndpoint: entry.client.authUrl,
          tokenEndpoint: entry.client.tokenUrl,
          jwksUrl: entry.client.jwksUrl,
        };
        discovered.set(
          projectionKey(registration.issuer, registration.clientId, registration.deploymentId),
          registration,
        );
      }
    }

    return this.reconcile(tenantId, [...discovered.values()]);
  }

  private prepareUpsert(input: HarborRegistrationPersistInput, now: string): D1PreparedStatement {
    return this.database
      .prepare(REGISTRATION_UPSERT_SQL)
      .bind(
        input.registrationId,
        input.tenantId,
        input.issuer,
        input.clientId,
        input.deploymentId,
        input.authorizationEndpoint,
        input.tokenEndpoint,
        input.jwksUrl,
        now,
        now,
      );
  }

  private async assertProjectionsPresent(
    tenantId: string,
    discovered: ReadonlyArray<DiscoveredRegistrationProjection>,
  ): Promise<void> {
    const projected = await this.readExistingForTenant(tenantId, discovered);
    for (const registration of discovered) {
      if (
        !projected.has(
          projectionKey(registration.issuer, registration.clientId, registration.deploymentId),
        )
      ) {
        throw new Error("LTI registration projection reconcile left a registration missing");
      }
    }
  }

  private async readExistingForTenant(
    tenantId: string,
    discovered: ReadonlyArray<DiscoveredRegistrationProjection>,
  ): Promise<Map<string, ExistingProjection>> {
    if (discovered.length === 0) {
      return new Map();
    }

    const keysJson = JSON.stringify(
      discovered.map(({ issuer, clientId, deploymentId }) => [issuer, clientId, deploymentId]),
    );
    const rows = await this.database
      .prepare(
        `WITH requested(issuer, client_id, deployment_id) AS (
           SELECT
             json_extract(value, '$[0]'),
             json_extract(value, '$[1]'),
             json_extract(value, '$[2]')
           FROM json_each(?)
         )
         SELECT registrations.id,
                registrations.tenant_id,
                registrations.issuer,
                registrations.client_id,
                registrations.deployment_id
         FROM lti_registrations registrations
         INNER JOIN requested
           ON requested.issuer = registrations.issuer
          AND requested.client_id = registrations.client_id
          AND requested.deployment_id = registrations.deployment_id`,
      )
      .bind(keysJson)
      .all<ExistingProjection>();

    const existing = new Map<string, ExistingProjection>();
    for (const row of rows.results) {
      if (row.tenant_id !== tenantId) {
        throw new LtiRegistrationError(409, "LTI registration is already owned by another tenant");
      }
      existing.set(projectionKey(row.issuer, row.client_id, row.deployment_id), row);
    }
    return existing;
  }
}

function toDiscoveredProjection(
  input: HarborRegistrationPersistInput,
): DiscoveredRegistrationProjection {
  return {
    issuer: input.issuer,
    clientId: input.clientId,
    deploymentId: input.deploymentId,
    authorizationEndpoint: input.authorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    jwksUrl: input.jwksUrl,
  };
}

function projectionKey(issuer: string, clientId: string, deploymentId: string): string {
  return JSON.stringify([issuer, clientId, deploymentId]);
}

interface ProtocolRegistrationDiscoverySource {
  listClients(): Promise<ReadonlyArray<Omit<LTIClient, "deployments">>>;
  listDeployments(clientId: string): Promise<ReadonlyArray<LTIDeployment>>;
}

function throwRegistrationTenantConflict(cause: unknown): never {
  if (cause instanceof Error && cause.message.includes(REGISTRATION_TENANT_CONFLICT_MARKER)) {
    throw new LtiRegistrationError(409, "LTI registration is already owned by another tenant");
  }
  throw cause;
}
