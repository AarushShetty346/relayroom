export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: any,
  ) {
    super(message);
  }
}

/**
 * JSON fetch against the RelayRoom API. Sends the CSRF header on every request and treats 409
 * "needsConfirmation" responses as data, not errors.
 */
export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "x-relayroom-csrf": "1",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = { message: text };
  }
  if (res.status === 409 && data?.needsConfirmation) return data as T;
  if (!res.ok) {
    const details = Array.isArray(data?.details) ? `: ${data.details.map((d: any) => `${d.path} ${d.message}`).join(", ")}` : "";
    throw new ApiError(res.status, (data?.message ?? `Request failed (${res.status})`) + details, data);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);
export const patch = <T = any>(p: string, b: unknown) => api<T>("PATCH", p, b);
export const del = <T = any>(p: string) => api<T>("DELETE", p);
