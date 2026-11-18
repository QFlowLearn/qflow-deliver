declare module "cloudflare:test" {
  export function runDurableObjectAlarm(stub: DurableObjectStub): Promise<boolean>;
  export function abortAllDurableObjects(): Promise<void>;
  export function runInDurableObject<R>(stub: DurableObjectStub, callback: (instance: unknown, state: DurableObjectState) => R | Promise<R>): Promise<R>;
  export function createExecutionContext(): ExecutionContext;
  export function createMessageBatch<T>(
    queueName: string,
    messages: Array<{
      id: string;
      timestamp: Date;
      attempts: number;
      body: T;
    }>,
  ): MessageBatch<T>;
  export const env: import("./src/index").Env & {
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  };
  export function getQueueResult(
    ctx: ExecutionContext,
    queueName: string,
  ): Promise<{ outcome: string; explicitAcks: string[] }>;
  export function getQueueResult(
    batch: MessageBatch<unknown>,
    ctx: ExecutionContext,
  ): Promise<{ outcome: string; explicitAcks: string[] }>;
  export function waitOnExecutionContext(ctx: ExecutionContext): Promise<void>;
  export function applyD1Migrations(
    db: D1Database,
    migrationsPath?: string | Array<{ name: string; queries: string[] }>,
  ): Promise<void>;
}

declare module "*?raw" {
  const source: string;
  export default source;
}

type RuntimeTestBindings = import("./src/env").Env;

declare namespace Cloudflare {
  interface Env extends RuntimeTestBindings {
    TEST_MIGRATIONS: Array<{ name: string; queries: string[] }>;
  }

  interface GlobalProps {
    mainModule: {
      default: typeof import("./src/index").default;
    };
  }
}
