import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, sep } from "node:path";

/**
 * The data directory (`.ua/`, or the legacy `.understand-anything/`) lives
 * inside the analyzed repository, and teams are encouraged to commit it. A
 * hostile repo can therefore ship `.ua` (or any file in it) as a symlink and
 * turn a plain `writeFileSync` into "overwrite ~/.zshrc". Everything that
 * reads or writes the data directory goes through the helpers below.
 */
export class UnsafeDataDirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeDataDirError";
  }
}

/** lstat that maps "does not exist" to null instead of throwing. */
function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/**
 * True when something exists at `path`, counting symlinks (even dangling ones)
 * as existing. Unlike `existsSync` this never follows the link.
 */
export function existsNoFollow(path: string): boolean {
  return lstatOrNull(path) !== null;
}

/**
 * Throw UnsafeDataDirError unless `dir` is absent, or a real directory (not a
 * symlink / junction) whose realpath is inside realpath(projectRoot).
 * Returns true when the directory exists, false when it does not.
 */
export function assertSafeDir(projectRoot: string, dir: string): boolean {
  const stat = lstatOrNull(dir);
  if (stat === null) return false;
  if (stat.isSymbolicLink()) {
    throw new UnsafeDataDirError(
      `${dir} is a symbolic link; refusing to read or write through it`,
    );
  }
  if (!stat.isDirectory()) {
    throw new UnsafeDataDirError(`${dir} exists but is not a directory`);
  }
  const rel = relative(realpathSync(projectRoot), realpathSync(dir));
  if (rel === "" || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new UnsafeDataDirError(
      `${dir} resolves outside the project root; refusing to use it`,
    );
  }
  return true;
}

/** Create `dir` if needed, re-checking it afterwards. Returns `dir`. */
export function ensureSafeDir(projectRoot: string, dir: string): string {
  if (!assertSafeDir(projectRoot, dir)) {
    mkdirSync(dir, { recursive: true });
    assertSafeDir(projectRoot, dir);
  }
  return dir;
}

function assertPlainFileName(fileName: string): void {
  if (
    fileName === "" ||
    fileName === "." ||
    fileName === ".." ||
    fileName !== basename(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error(`Invalid data file name: ${JSON.stringify(fileName)}`);
  }
}

const RENAME_RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

function renameWithRetry(from: string, to: string): void {
  // POSIX rename() never fails because the target is open. Windows can (AV
  // scanners, a dashboard reading the file), so retry briefly there.
  const attempts = process.platform === "win32" ? 6 : 1;
  for (let i = 1; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "";
      if (i >= attempts || !RENAME_RETRYABLE.has(code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * i);
    }
  }
}

/**
 * Write `data` to `<dir>/<fileName>` without ever following a symlink: the
 * data dir must pass assertSafeDir, the bytes go to a fresh temp file created
 * exclusively (`wx` = O_CREAT|O_EXCL, which refuses an existing path even if
 * it is a symlink), and the temp file is then renamed onto the target.
 * rename() replaces a symlink at the target instead of writing through it, and
 * readers never see a half-written file.
 */
export function safeWriteFile(
  projectRoot: string,
  dir: string,
  fileName: string,
  data: string,
): void {
  assertPlainFileName(fileName);
  ensureSafeDir(projectRoot, dir);
  const target = join(dir, fileName);
  const tmp = join(
    dir,
    `.${fileName}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx");
    writeFileSync(fd, data, "utf-8");
    try {
      fsyncSync(fd);
    } catch {
      // Best effort: some filesystems do not support fsync.
    }
    closeSync(fd);
    fd = undefined;
    renameWithRetry(tmp, target);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed or invalid; nothing more to do.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Temp file was never created or is already gone.
    }
    throw err;
  }
}

/**
 * Read `<dir>/<fileName>` as UTF-8. Returns null when the file (or the data
 * dir) does not exist. Throws UnsafeDataDirError when the data dir is unsafe or
 * the file is a symlink / not a regular file.
 */
export function safeReadFile(
  projectRoot: string,
  dir: string,
  fileName: string,
): string | null {
  assertPlainFileName(fileName);
  if (!assertSafeDir(projectRoot, dir)) return null;
  const target = join(dir, fileName);
  const stat = lstatOrNull(target);
  if (stat === null) return null;
  if (stat.isSymbolicLink()) {
    throw new UnsafeDataDirError(
      `${target} is a symbolic link; refusing to read it`,
    );
  }
  if (!stat.isFile()) {
    throw new UnsafeDataDirError(`${target} is not a regular file`);
  }
  // O_NOFOLLOW closes the lstat -> open race on platforms that have it
  // (it is undefined on Windows, where it falls back to the lstat check).
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) {
      throw new UnsafeDataDirError(`${target} is not a regular file`);
    }
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}
