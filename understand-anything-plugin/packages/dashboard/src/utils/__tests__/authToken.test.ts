import { describe, expect, it } from "vitest";
import {
  SESSION_TOKEN_KEY,
  clearStoredToken,
  extractTokenFromLocation,
  isAuthFailure,
  readStoredToken,
  storeToken,
} from "../authToken";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

const throwingStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  removeItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
};

describe("token storage", () => {
  it("round-trips and clears a token", () => {
    const storage = memoryStorage();
    expect(readStoredToken(storage)).toBeNull();
    storeToken("abc", storage);
    expect(storage.data.get(SESSION_TOKEN_KEY)).toBe("abc");
    expect(readStoredToken(storage)).toBe("abc");
    clearStoredToken(storage);
    expect(readStoredToken(storage)).toBeNull();
  });

  it("treats an empty stored value as no token", () => {
    const storage = memoryStorage();
    storage.setItem(SESSION_TOKEN_KEY, "");
    expect(readStoredToken(storage)).toBeNull();
  });

  it("never throws when storage is blocked", () => {
    expect(readStoredToken(throwingStorage)).toBeNull();
    expect(() => storeToken("abc", throwingStorage)).not.toThrow();
    expect(() => clearStoredToken(throwingStorage)).not.toThrow();
  });

  it("works with no storage at all (blocked or non-browser)", () => {
    expect(readStoredToken(null)).toBeNull();
    expect(() => storeToken("abc", null)).not.toThrow();
    expect(() => clearStoredToken(null)).not.toThrow();
  });
});

describe("isAuthFailure", () => {
  it("is true for 401 and for the server's invalid-token 403", () => {
    expect(isAuthFailure(401)).toBe(true);
    expect(isAuthFailure(403, "Forbidden: missing or invalid token")).toBe(true);
  });

  it("is false for other statuses and for 403s that are not about the token", () => {
    expect(isAuthFailure(200)).toBe(false);
    expect(isAuthFailure(404, "No knowledge graph found. Run /understand first.")).toBe(false);
    expect(isAuthFailure(409, "Refusing to read data file: knowledge-graph.json is a symlink")).toBe(false);
    expect(isAuthFailure(403, "Path resolves outside the project (symlink)")).toBe(false);
    expect(isAuthFailure(403)).toBe(false);
  });
});

describe("extractTokenFromLocation", () => {
  it("pulls the token out and returns the URL without it", () => {
    expect(
      extractTokenFromLocation({ pathname: "/", search: "?token=abc123", hash: "" }),
    ).toEqual({ token: "abc123", cleanUrl: "/" });
    expect(
      extractTokenFromLocation({ pathname: "/x", search: "?a=1&token=abc&b=2", hash: "#h" }),
    ).toEqual({ token: "abc", cleanUrl: "/x?a=1&b=2#h" });
  });

  it("reports no token when there is none", () => {
    expect(extractTokenFromLocation({ pathname: "/", search: "", hash: "" })).toEqual({
      token: null,
      cleanUrl: "/",
    });
    expect(extractTokenFromLocation({ pathname: "/", search: "?token=", hash: "" }).token).toBeNull();
  });
});
