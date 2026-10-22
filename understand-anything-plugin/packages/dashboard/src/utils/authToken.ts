/**
 * Access-token handling for the dashboard page. The token arrives as
 * `?token=` (stripped from the address bar on load) and is kept in
 * sessionStorage so a reload keeps working.
 *
 * Browsers can block storage entirely (private modes, blocked site data,
 * sandboxed frames) — even *reading* `window.sessionStorage` can throw — so
 * every access here is wrapped and degrades to "no stored token".
 */
export const SESSION_TOKEN_KEY = "understand-anything-token";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The page's sessionStorage, or null when storage is unavailable/blocked. */
export function getSessionStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readStoredToken(storage: StorageLike | null = getSessionStorage()): string | null {
  try {
    const token = storage?.getItem(SESSION_TOKEN_KEY);
    return token ? token : null;
  } catch {
    return null;
  }
}

export function storeToken(token: string, storage: StorageLike | null = getSessionStorage()): void {
  try {
    storage?.setItem(SESSION_TOKEN_KEY, token);
  } catch {
    // Storage blocked or full: the token just won't survive a reload.
  }
}

export function clearStoredToken(storage: StorageLike | null = getSessionStorage()): void {
  try {
    storage?.removeItem(SESSION_TOKEN_KEY);
  } catch {
    // Nothing useful to do.
  }
}

/**
 * Did the server reject the access token? The servers answer 403 with a
 * "...missing or invalid token" error for that; other 403s (Host header,
 * source file outside the project) are not a token problem and must not send
 * the user back to the token gate. 401 is always an auth failure.
 */
export function isAuthFailure(status: number, errorMessage?: string): boolean {
  if (status === 401) return true;
  return status === 403 && /token/i.test(errorMessage ?? "");
}

/** Thrown by data loaders when the server rejected the access token. */
export class AuthFailureError extends Error {
  constructor(message = "Access token rejected") {
    super(message);
    this.name = "AuthFailureError";
  }
}

export interface TokenFromUrl {
  token: string | null;
  /** The URL (path + search + hash) with `token` removed, for history.replaceState. */
  cleanUrl: string;
}

/** Pull `?token=` out of a location, returning the URL to show instead. */
export function extractTokenFromLocation(location: {
  pathname: string;
  search: string;
  hash: string;
}): TokenFromUrl {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || null;
  params.delete("token");
  const cleanSearch = params.toString();
  return {
    token,
    cleanUrl: location.pathname + (cleanSearch ? `?${cleanSearch}` : "") + location.hash,
  };
}
