import type { AttemptItemStateStore } from "../attempt-journal";
import type { BootstrappedSession } from "../bootstrap-client";
import type { RefLike } from "./ref-like";

interface RecoverySessionCache {
  launchKey: string;
  session: BootstrappedSession;
  clientSessionId: string;
  tabId: string;
  updatedAt: number;
  closedAt: number | null;
}

const BOOTSTRAPPED_SESSION_KEY = "harbor.bootstrappedSession";
const CLIENT_SESSION_STORAGE_KEY = "harbor.clientSessionId";
const ITEM_STATES_SESSION_KEY_PREFIX = "harbor.itemStates";
const RECOVERY_SESSION_KEY_PREFIX = "harbor.recoverySession";
const TAB_ID_SESSION_STORAGE_KEY = "harbor.tabId";
const RECOVERY_ACTIVE_TAB_TTL_MS = 15_000;

export interface RuntimeRecoveryCache {
  readOrCreateClientSessionId(this: void): string;
  readOrCreateTabId(this: void): string;
  writeCachedBootstrappedSession(this: void, session: BootstrappedSession): void;
  readCachedBootstrappedSession(this: void): BootstrappedSession | null;
  writeRecoverySession(this: void, session: BootstrappedSession, closedAt: number | null): void;
  readRecoverySession(this: void): BootstrappedSession | null;
  markRecoverySessionClosed(this: void): void;
  writeCachedItemStates(
    this: void,
    attemptId: string,
    itemStates: Record<string, unknown>,
  ): Promise<void>;
  readCachedItemStates(this: void, attemptId: string): Promise<Record<string, unknown>>;
  readLaunchKey(this: void, url?: URL): string;
}

export function createRuntimeRecoveryCache(input: {
  itemStateStore: AttemptItemStateStore;
  currentClientSessionId: RefLike<string>;
  bootstrappedSession: RefLike<BootstrappedSession | null>;
  getLocationHref(this: void): string;
}): RuntimeRecoveryCache {
  function getClientSessionId(): string {
    return input.currentClientSessionId.value;
  }

  function setClientSessionId(value: string): void {
    input.currentClientSessionId.value = value;
  }

  function getBootstrappedSession(): BootstrappedSession | null {
    return input.bootstrappedSession.value;
  }
  function readOrCreateClientSessionId(): string {
    const existing = window.sessionStorage.getItem(CLIENT_SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const created = `client_session_${crypto.randomUUID().replaceAll("-", "")}`;
    window.sessionStorage.setItem(CLIENT_SESSION_STORAGE_KEY, created);
    return created;
  }

  function readOrCreateTabId(): string {
    const existing = window.sessionStorage.getItem(TAB_ID_SESSION_STORAGE_KEY);
    if (existing) {
      return existing;
    }

    const created = `tab_${crypto.randomUUID().replaceAll("-", "")}`;
    window.sessionStorage.setItem(TAB_ID_SESSION_STORAGE_KEY, created);
    return created;
  }

  function writeCachedBootstrappedSession(session: BootstrappedSession): void {
    window.sessionStorage.setItem(
      BOOTSTRAPPED_SESSION_KEY,
      JSON.stringify({
        launchKey: readLaunchKey(),
        session,
      }),
    );
  }

  function readCachedBootstrappedSession(): BootstrappedSession | null {
    const rawValue = window.sessionStorage.getItem(BOOTSTRAPPED_SESSION_KEY);
    if (rawValue) {
      try {
        const parsed = JSON.parse(rawValue) as {
          launchKey?: string;
          session?: BootstrappedSession;
        };

        if (
          parsed &&
          typeof parsed === "object" &&
          parsed.session &&
          (parsed.launchKey ?? "") === readLaunchKey()
        ) {
          return parsed.session;
        }
      } catch {
        return null;
      }
    }

    return readRecoverySession();
  }

  function writeRecoverySession(session: BootstrappedSession, closedAt: number | null): void {
    const clientSessionId = getClientSessionId();
    if (!clientSessionId) {
      return;
    }

    const cached: RecoverySessionCache = {
      launchKey: readLaunchKey(),
      session,
      clientSessionId,
      tabId: readOrCreateTabId(),
      updatedAt: Date.now(),
      closedAt,
    };

    window.localStorage.setItem(buildRecoverySessionStorageKey(), JSON.stringify(cached));
  }

  function readRecoverySession(): BootstrappedSession | null {
    const rawValue = window.localStorage.getItem(buildRecoverySessionStorageKey());
    if (!rawValue) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue) as Partial<RecoverySessionCache>;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        !parsed.session ||
        !parsed.clientSessionId ||
        parsed.launchKey !== readLaunchKey()
      ) {
        return null;
      }

      const tabClosed = typeof parsed.closedAt === "number";
      const activeTabExpired =
        typeof parsed.updatedAt === "number" &&
        Date.now() - parsed.updatedAt > RECOVERY_ACTIVE_TAB_TTL_MS;

      if (!tabClosed && !activeTabExpired) {
        return null;
      }

      setClientSessionId(parsed.clientSessionId);
      window.sessionStorage.setItem(CLIENT_SESSION_STORAGE_KEY, parsed.clientSessionId);
      return parsed.session;
    } catch {
      return null;
    }
  }

  function markRecoverySessionClosed(): void {
    const session = getBootstrappedSession();
    if (session) {
      writeRecoverySession(session, Date.now());
    }
  }

  function buildRecoverySessionStorageKey(): string {
    return `${RECOVERY_SESSION_KEY_PREFIX}:${readLaunchKey()}`;
  }

  function writeCachedItemStates(
    attemptId: string,
    itemStates: Record<string, unknown>,
  ): Promise<void> {
    return input.itemStateStore.write(attemptId, itemStates).then(() => {
      window.sessionStorage.removeItem(buildItemStatesStorageKey(attemptId));
    });
  }

  async function readCachedItemStates(attemptId: string): Promise<Record<string, unknown>> {
    const storedItemStates = await input.itemStateStore.read(attemptId);
    if (Object.keys(storedItemStates).length > 0) {
      return storedItemStates;
    }

    const rawValue = window.sessionStorage.getItem(buildItemStatesStorageKey(attemptId));
    if (!rawValue) {
      return {};
    }

    try {
      const parsed = JSON.parse(rawValue, (_key, value) => {
        if (
          value &&
          typeof value === "object" &&
          "__harborMap" in value &&
          Array.isArray((value as { entries?: unknown }).entries)
        ) {
          return new Map((value as { entries: Array<[string, unknown]> }).entries);
        }

        return value;
      }) as Record<string, unknown>;
      const legacyItemStates = parsed && typeof parsed === "object" ? parsed : {};
      if (Object.keys(legacyItemStates).length > 0) {
        await input.itemStateStore.write(attemptId, legacyItemStates);
        window.sessionStorage.removeItem(buildItemStatesStorageKey(attemptId));
      }

      return legacyItemStates;
    } catch {
      return {};
    }
  }

  function buildItemStatesStorageKey(attemptId: string): string {
    return `${ITEM_STATES_SESSION_KEY_PREFIX}:${attemptId}`;
  }

  function readLaunchKey(url: URL = new URL(input.getLocationHref())): string {
    return [
      "mode",
      "assessmentVersionId",
      "previewActorId",
      "previewActorDisplayName",
      "accessCode",
      "accessCodeAssessmentVersionId",
      "candidateId",
      "candidateName",
    ]
      .map((key) => {
        const value = url.searchParams.get(key);
        return value ? `${key}=${value}` : null;
      })
      .filter((value): value is string => value !== null)
      .join("&");
  }

  return {
    readOrCreateClientSessionId,
    readOrCreateTabId,
    writeCachedBootstrappedSession,
    readCachedBootstrappedSession,
    writeRecoverySession,
    readRecoverySession,
    markRecoverySessionClosed,
    writeCachedItemStates,
    readCachedItemStates,
    readLaunchKey,
  };
}
