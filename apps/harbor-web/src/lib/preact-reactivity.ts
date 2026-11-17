import { computed as computedSignal, effect, signal, type Signal } from "@preact/signals";
import { useEffect, useMemo } from "preact/hooks";

type WatchSource<T> = Signal<T> | (() => T);
type WatchSourceValue<T> =
  T extends Signal<infer Value> ? Value : T extends () => infer Value ? Value : never;
type WatchSourceValues<T extends readonly WatchSource<unknown>[]> = {
  [Index in keyof T]: WatchSourceValue<T[Index]>;
};
type Watchable = WatchSource<unknown> | readonly WatchSource<unknown>[];
type WatchValue<T extends Watchable> = T extends readonly WatchSource<unknown>[]
  ? WatchSourceValues<T>
  : T extends WatchSource<unknown>
    ? WatchSourceValue<T>
    : never;

const reactiveVersion = Symbol("harbor.reactiveVersion");
const setupLifecycleVersion = Symbol("harbor.setupLifecycle");

interface SetupLifecycle {
  mountedCallbacks: Array<() => void | Promise<void>>;
  cleanupCallbacks: Array<() => void>;
}

let activeSetupLifecycle: SetupLifecycle | null = null;

export type Ref<T> = Signal<T>;
export type ComputedRef<T> = Signal<T>;

export function ref<T>(value: T): Signal<T> {
  return signal(value);
}

export function computed<T>(fn: () => T): Signal<T> {
  return computedSignal(fn);
}

export function reactive<T extends object>(value: T): T {
  const version = signal(0);
  return new Proxy(value, {
    get(target, property, receiver) {
      if (property === reactiveVersion) return version;
      version.value;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, next, receiver) {
      const current = Reflect.get(target, property, receiver);
      const ok = Reflect.set(target, property, next, receiver);
      if (ok && current !== next) version.value += 1;
      return ok;
    },
  });
}

export function watch<Source extends Watchable>(
  source: Source,
  callback: (
    value: WatchValue<Source>,
    previous: WatchValue<Source> | undefined,
  ) => void | Promise<void>,
  options: { immediate?: boolean } = {},
): () => void {
  let initialized = false;
  let previous: WatchValue<Source> | undefined;

  const dispose = effect(() => {
    const value = readWatchSource(source) as WatchValue<Source>;
    if (!initialized) {
      initialized = true;
      previous = value;
      if (options.immediate) scheduleWatchCallback(callback, value, undefined);
      return;
    }

    const prior = previous;
    previous = value;
    scheduleWatchCallback(callback, value, prior);
  });
  requireActiveSetupLifecycle("watch").cleanupCallbacks.push(dispose);
  return dispose;
}

export function nextTick(): Promise<void> {
  return Promise.resolve();
}

export function onMounted(callback: () => void | Promise<void>): void {
  requireActiveSetupLifecycle("onMounted").mountedCallbacks.push(callback);
}

export function onBeforeUnmount(callback: () => void): void {
  requireActiveSetupLifecycle("onBeforeUnmount").cleanupCallbacks.push(callback);
}

export function useSetup<T>(factory: () => T): T {
  const setup = useMemo(() => {
    const lifecycle: SetupLifecycle = {
      mountedCallbacks: [],
      cleanupCallbacks: [],
    };
    const previousLifecycle = activeSetupLifecycle;
    activeSetupLifecycle = lifecycle;
    try {
      return {
        value: factory(),
        [setupLifecycleVersion]: lifecycle,
      };
    } finally {
      activeSetupLifecycle = previousLifecycle;
    }
  }, []);

  useEffect(() => {
    let active = true;
    for (const callback of setup[setupLifecycleVersion].mountedCallbacks) {
      queueMicrotask(() => {
        if (active) {
          void callback();
        }
      });
    }

    return () => {
      active = false;
      const callbacks = setup[setupLifecycleVersion].cleanupCallbacks;
      for (let index = callbacks.length - 1; index >= 0; index -= 1) {
        callbacks[index]?.();
      }
    };
  }, [setup]);

  return setup.value;
}

function readWatchSource(source: Watchable): unknown {
  if (Array.isArray(source)) {
    return source.map((entry) => readSingleWatchSource(entry));
  }

  return readSingleWatchSource(source as WatchSource<unknown>);
}

function readSingleWatchSource<T>(source: WatchSource<T>): T {
  if (typeof source === "function") return source();
  return source.value;
}

function scheduleWatchCallback<T>(
  callback: (value: T, previous: T | undefined) => void | Promise<void>,
  value: T,
  previous: T | undefined,
): void {
  queueMicrotask(() => {
    void callback(value, previous);
  });
}

function requireActiveSetupLifecycle(apiName: string): SetupLifecycle {
  if (!activeSetupLifecycle) {
    throw new Error(`${apiName} must be called synchronously inside useSetup().`);
  }
  return activeSetupLifecycle;
}
