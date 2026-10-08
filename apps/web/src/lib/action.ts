import type { ActionResult } from "@/server/result";

export class ActionError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = type;
  }
}

/** The data of a successful action result, or throw its error. */
export function unwrap<T>(result: ActionResult<T>): T {
  if (result.ok) return result.data;
  throw new ActionError(result.error.type, result.error.message);
}
