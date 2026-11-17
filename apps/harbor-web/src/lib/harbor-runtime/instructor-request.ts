import type { RefLike } from "./ref-like";
import { formatError as defaultFormatError } from "./formatting";

export async function runInstructorRequest<T>(input: {
  busy?: RefLike<boolean>;
  error?: RefLike<string>;
  run: () => Promise<T>;
  onError?: (error: unknown) => void;
  formatError?: (error: unknown) => string;
}): Promise<T> {
  const format = input.formatError ?? defaultFormatError;

  if (input.busy) {
    input.busy.value = true;
  }
  if (input.error) {
    input.error.value = "";
  }

  try {
    return await input.run();
  } catch (error) {
    if (input.error) {
      input.error.value = format(error);
    }
    input.onError?.(error);
    throw error;
  } finally {
    if (input.busy) {
      input.busy.value = false;
    }
  }
}
