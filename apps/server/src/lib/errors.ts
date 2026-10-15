export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code = "error",
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, "bad_request", details);
export const unauthorized = (msg = "Sign in required") => new HttpError(401, msg, "unauthorized");
export const forbidden = (msg = "Not allowed") => new HttpError(403, msg, "forbidden");
export const notFound = (msg = "Not found") => new HttpError(404, msg, "not_found");
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, "conflict", details);
