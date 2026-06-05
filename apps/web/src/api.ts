// undefined = not yet fetched; null = server confirmed no token; string = token
let tokenCache: string | null | undefined = undefined;

async function getToken(): Promise<string | null> {
  if (tokenCache !== undefined) return tokenCache;
  try {
    const res = await fetch("/api/local-token");
    if (res.ok) {
      const data = (await res.json()) as { token?: string };
      tokenCache = data.token ?? null;
    } else {
      tokenCache = null;
    }
  } catch {
    tokenCache = null;
  }
  return tokenCache;
}

export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return fetch(url, init);
  }
  const token = await getToken();
  if (!token) {
    return fetch(url, init);
  }
  const headers = new Headers(init?.headers);
  headers.set("x-pathlight-token", token);
  return fetch(url, { ...init, headers });
}

export function setTokenForTesting(token: string | null | undefined) {
  tokenCache = token;
}
