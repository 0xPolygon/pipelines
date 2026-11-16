import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

export type FileRead =
  | { kind: 'text'; text: string }
  | { kind: 'missing' }
  | { kind: 'directory' }
  /** A link, device, pipe or anything else that is not a regular file; never followed. */
  | { kind: 'not-regular' }
  | { kind: 'too-large' };

/**
 * Reads a file through one descriptor: the type and size checks are made on the
 * descriptor that is then read, so the path cannot be swapped between the check
 * and the read. `O_NOFOLLOW` refuses a link as the final path component and
 * `O_NONBLOCK` keeps the open of a pipe from waiting for a writer.
 */
export const readRegularFile = ({
  path,
  maxBytes
}: {
  path: string;
  maxBytes: number;
}): FileRead => {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? err.code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'not-regular' };
    throw err;
  }
  try {
    const info = fstatSync(fd);
    if (info.isDirectory()) return { kind: 'directory' };
    if (!info.isFile()) return { kind: 'not-regular' };
    if (info.size > maxBytes) return { kind: 'too-large' };
    return { kind: 'text', text: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
};
