import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { LhrError } from './errors.js';

export const FORMAT_VERSION = 2;

const MAX_SHOWN = 20;

/** Verifies `<root>/.lhr/format` exists and holds the supported version. */
export async function checkFormat(root: string): Promise<void> {
  let text: string;
  try {
    text = await readFile(path.join(root, '.lhr', 'format'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new LhrError('FORMAT_MISSING', `No .lhr/format file found in ${root}`);
    }
    throw err;
  }
  if (text === '2' || text === '2\n' || text === '2\r\n') return;
  const shown = text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN)}...` : text;
  throw new LhrError(
    'FORMAT_VERSION',
    `Unsupported .lhr/format ${JSON.stringify(shown)}; supported version is ${FORMAT_VERSION}`,
  );
}
