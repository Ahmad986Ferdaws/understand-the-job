// Type declarations for server-guards.mjs (consumed by the dashboard's
// vite.config.ts, which is type-checked via its test).
import type { ChildProcess, SpawnOptions } from "node:child_process";

export const MAX_SOURCE_FILE_BYTES: number;
export const MAX_DATA_FILE_BYTES: number;
export const UA_DIR_CANDIDATES: string[];

export function buildCsp(options?: { dev?: boolean; meta?: boolean }): string;
export const BASE_SECURITY_HEADERS: Readonly<Record<string, string>>;
export function applySecurityHeaders(
  res: { setHeader(name: string, value: string): unknown },
  options?: { html?: boolean; dev?: boolean },
): void;

export function isAllowedHost(hostHeader: unknown, port?: number): boolean;
export function tokensMatch(provided: unknown, expected: unknown): boolean;
export function resolveAccessToken(env?: Record<string, string | undefined>): string;

export function isInside(root: string, candidate: string): boolean;
export function normalizeGraphPath(filePath: string, projectRoot: string): string | null;
export function relativizeNodePaths<T>(raw: T, projectRoot: string): T;
export function detectLanguage(filePath: string): string;

export class UnsafeDataFileError extends Error {}
export function lexists(target: string): boolean;
export function assertSafeDataDir(projectRoot: string, dataDir: string): void;
export function readDataFile(dataDir: string, fileName: string, projectRoot?: string): string;
export function readSanitizedJson(dataDir: string, fileName: string, projectRoot?: string): unknown;

export function createAllowlistCache(): {
  get(dataDir: string, projectRoot?: string): Set<string>;
};

export interface SourceFileResult {
  statusCode: number;
  payload: Record<string, unknown>;
}
export function readSourceFile(options: {
  projectRoot: string;
  requestedPath: string;
  allowedPaths: Set<string> | (() => Set<string>);
}): SourceFileResult;

export function openInBrowser(
  url: string,
  options?: {
    platform?: string;
    spawnFn?: (command: string, args: string[], options: SpawnOptions) => Pick<ChildProcess, "on" | "unref">;
    log?: (message: string) => void;
  },
): boolean;
