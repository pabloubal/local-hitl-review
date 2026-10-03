// Colour and width helpers (docs/spec/cli.md § Colour and width). Human output
// slices build on these; nothing here reads repo state.

const DEFAULT_WIDTH = 80;
const MAX_RULE = 100;

/** ANSI colour only when the stream is a terminal and NO_COLOR is unset or empty. */
export function useColor(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return stream.isTTY === true && (env.NO_COLOR === undefined || env.NO_COLOR === '');
}

/** Terminal columns, else `COLUMNS`, else 80. */
export function termWidth(
  stream: { isTTY?: boolean; columns?: number } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (stream.isTTY === true && stream.columns && stream.columns > 0) return stream.columns;
  const cols = Number(env.COLUMNS);
  if (Number.isInteger(cols) && cols > 0) return cols;
  return DEFAULT_WIDTH;
}

/** Horizontal rules cap at 100 columns. */
export function ruleWidth(width: number = termWidth()): number {
  return Math.min(width, MAX_RULE);
}

const SGR = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  magenta: [35, 39],
  cyan: [36, 39],
} as const;

export type Style = keyof typeof SGR;

/** Wraps `text` in the given styles when `color` is on; returns it untouched otherwise. */
export function paint(color: boolean, text: string, ...styles: Style[]): string {
  if (!color || styles.length === 0) return text;
  const open = styles.map((s) => `\u001b[${SGR[s][0]}m`).join('');
  const close = [...styles]
    .reverse()
    .map((s) => `\u001b[${SGR[s][1]}m`)
    .join('');
  return `${open}${text}${close}`;
}
