export interface RefLike<T> {
  value: T;
}

export type ReadonlyRefLike<T> = Pick<RefLike<T>, "value">;

export interface MutableRef<T> {
  current: T | null;
}

export function requireMutableRef<T>(ref: MutableRef<T>, label: string): T {
  if (!ref.current) {
    throw new Error(`${label} is not initialized.`);
  }

  return ref.current;
}
