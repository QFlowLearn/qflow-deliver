// Test-only composition: production routing/state transitions with controllable delivery time
// and a pausable adapter that forwards queries to the real local D1 database.
import { AttemptDurableObject as RuntimeAttempt } from "../src/attempts/attempt-durable-object";
import type { Env } from "../src/env";
export { default, ResultRemediationWorkflow } from "../src/index";

class QueryGate {
  count = 0;
  finalizationCount = 0;
  private paused: Promise<void> | undefined;
  private releaseQuery: (() => void) | undefined;
  private entered: Promise<void> = Promise.resolve();
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private markEntered: (() => void) | undefined;

  hold(): void {
    this.paused = new Promise((resolve) => {
      this.releaseQuery = resolve;
    });
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve;
    });
  }
  release(): void {
    clearTimeout(this.releaseTimer);
    this.releaseQuery?.();
    this.paused = undefined;
  }
  waitForQuery(): Promise<void> {
    return this.entered;
  }
  async beforeRead(): Promise<void> {
    this.count++;
    this.markEntered?.();
    if (this.paused) {
      this.releaseTimer ??= setTimeout(() => this.release(), 3_000);
      await this.paused;
    }
  }
}

function observeStatement(
  statement: D1PreparedStatement,
  gate: QueryGate,
  kind: "deadline" | "finalization",
): D1PreparedStatement {
  return {
    bind: (...values) => observeStatement(statement.bind(...values), gate, kind),
    first: statement.first.bind(statement),
    async run<T>() {
      if (kind === "finalization") gate.finalizationCount++;
      return statement.run<T>();
    },
    raw: statement.raw.bind(statement),
    async all<T>() {
      if (kind === "deadline") await gate.beforeRead();
      return statement.all<T>();
    },
  };
}

function pauseDeadlineReads(db: D1Database, gate: QueryGate): D1Database {
  return {
    prepare(query) {
      const statement = db.prepare(query);
      if (
        query.startsWith(
          "SELECT id, scope_key, policy_version, deadline_at FROM attempt_deadline_jobs",
        )
      ) {
        return observeStatement(statement, gate, "deadline");
      }
      if (query.startsWith("INSERT OR IGNORE INTO result_finalizations")) {
        return observeStatement(statement, gate, "finalization");
      }
      return statement;
    },
    batch: db.batch.bind(db),
    exec: db.exec.bind(db),
    withSession: db.withSession.bind(db),
    dump: db.dump.bind(db),
  };
}

/** The deployed class remains unchanged; these controls exist only in the test main module. */
export class AttemptDurableObject extends RuntimeAttempt {
  private readonly queryGate: QueryGate;
  private readonly clock: { now?: number };
  constructor(
    private readonly testState: DurableObjectState,
    env: Env,
  ) {
    const gate = new QueryGate();
    const clock: { now?: number } = {};
    super(
      testState,
      { ...env, HARBOR_DB: pauseDeadlineReads(env.HARBOR_DB, gate) },
      () => clock.now ?? Date.now(),
    );
    this.queryGate = gate;
    this.clock = clock;
  }
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__test/outbox/")) return super.fetch(request);
    switch (path) {
      case "/__test/outbox/hold":
        this.queryGate.hold();
        break;
      case "/__test/outbox/release":
        this.queryGate.release();
        break;
      case "/__test/outbox/wait-for-query":
        await this.queryGate.waitForQuery();
        break;
      case "/__test/outbox/advance-alarm": {
        const alarm = await this.testState.storage.getAlarm();
        if (alarm !== null) this.clock.now = alarm;
        break;
      }
      case "/__test/outbox/advance-outbox": {
        const at = await this.testState.storage.get<number>("attempt-alarm-outbox-at");
        if (at === undefined) return new Response(null, { status: 404 });
        this.clock.now = at;
        break;
      }
      case "/__test/outbox/set-clock": {
        const value: unknown = await request.json();
        if (
          !value ||
          typeof value !== "object" ||
          !("now" in value) ||
          typeof value.now !== "number" ||
          !Number.isFinite(value.now)
        ) {
          return new Response(null, { status: 400 });
        }
        this.clock.now = value.now;
        break;
      }
      case "/__test/outbox/freeze-clock":
        this.clock.now = Date.now() + 10_000;
        break;
      case "/__test/outbox/status":
        return Response.json({
          queryCount: this.queryGate.count,
          finalizationCount: this.queryGate.finalizationCount,
        });
      default:
        return new Response(null, { status: 404 });
    }
    return new Response(null, { status: 204 });
  }
}
