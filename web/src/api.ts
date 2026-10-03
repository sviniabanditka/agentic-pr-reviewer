import { router } from "./router";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method,
    headers: { ...(method !== "GET" ? { "content-type": "application/json", "x-requested-with": "fetch" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    credentials: "same-origin",
  });
  if (res.status === 401 && !path.startsWith("/auth/") && !path.startsWith("/setup")) {
    const current = router.currentRoute.value;
    if (current.name !== "login" && current.name !== "setup") void router.push({ name: "login", query: { next: current.fullPath } });
    throw new ApiError("signed out", 401);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  return data;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  del: <T>(path: string) => request<T>("DELETE", path),
};
