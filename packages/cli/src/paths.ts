// Path arguments (docs/spec/cli.md, gap 8): a relative path is resolved against the
// current directory and used relative to the review root, with `/` separators.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { usageError } from './errors.js';

/** The nearest existing ancestor is realpath'd so a symlinked cwd compares equal to the root. */
function real(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = resolve(head, '..');
      if (parent === head) return p;
      tail.push(head.slice(parent.length).replace(/^[\\/]+/, ''));
      head = parent;
    }
  }
}

/**
 * Converts `input` (absolute, or relative to `cwd`) to a root-relative path with `/`
 * separators; the root itself is `''`. A path outside `root` is INVALID_INPUT (exit 2).
 * `root` and `cwd` are absolute directories.
 */
export function toRootRelative(root: string, cwd: string, input: string, see: string): string {
  const abs = real(isAbsolute(input) ? resolve(input) : resolve(cwd, input));
  const rel = relative(real(root), abs);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw usageError(`path "${input}" is outside the review root (${root})`, see);
  }
  return rel.split(sep).join('/');
}
