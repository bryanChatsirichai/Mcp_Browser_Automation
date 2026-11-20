import type { ErrorBody } from "./protocol.js";

/** An expected failure, reported to the model as `code` plus a message that says what to do next. */
export class ToolError extends Error {
  // Declared fields, not constructor parameter properties: the latter are not erasable syntax.
  code: string;
  extra: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.extra = extra;
  }
}

/** Any thrown value as a wire error body. Unexpected errors keep their message under code ERROR. */
export function toErrorBody(error: unknown): ErrorBody {
  if (error instanceof ToolError) {
    return { ...error.extra, code: error.code, message: error.message };
  }
  return {
    code: "ERROR",
    message: error instanceof Error ? error.message : String(error),
  };
}
