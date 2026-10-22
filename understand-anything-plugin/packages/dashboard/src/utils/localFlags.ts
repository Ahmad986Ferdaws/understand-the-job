/**
 * Tiny boolean flags in localStorage (e.g. "onboarding dismissed"). Storage
 * can be blocked or throw on access, so a failure means "flag not set" and
 * never crashes the page.
 */
export function readLocalFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function writeLocalFlag(key: string): void {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Storage blocked or full: the flag just won't persist.
  }
}
