// Static help text (docs/spec/cli.md § --help conventions). Plain text, no
// colour, never depends on repo state.

export interface CommandHelp {
  /** Words after `lhr`, e.g. `['thread', 'reply']`. */
  path: string[];
  summary: string;
  usage: string;
  args?: [string, string][];
  /** Command-specific flags; the global ones are appended automatically. */
  flags?: [string, string][];
  examples: string[];
  notes?: string[];
}

export const GLOBAL_FLAGS: [string, string][] = [
  ['--repo <path>', 'Start path for review-root discovery'],
  ['--json', 'Print the JSON envelope on stdout instead of text'],
  ['--as human|agent', 'Override the identity mode'],
  ['--dry-run', 'Write commands only: write nothing'],
  ['-h, --help', 'Show help for this command'],
];

export const COMMANDS: CommandHelp[] = [
  {
    path: ['init'],
    summary: 'Create .lhr/ at a directory.',
    usage: 'lhr init [path] [flags]',
    args: [['path', 'Directory to initialise (default: current directory)']],
    examples: ['lhr init', 'lhr init ../other-repo --dry-run'],
  },
  {
    path: ['inbox'],
    summary: "List open, submitted threads where it is the agent's turn.",
    usage: 'lhr inbox [flags]',
    flags: [['--all-sessions', 'Include threads from every agent session']],
    examples: ['lhr inbox', 'lhr inbox --all-sessions --json'],
  },
  {
    path: ['thread', 'list'],
    summary: 'List threads.',
    usage: 'lhr thread list [flags]',
    flags: [
      ['--status open|resolved|all', 'Thread status (default: open)'],
      ['--whose-turn human|agent', 'Only threads waiting on this side'],
      ['--path <path>', 'Only threads anchored under this path'],
      ['--round <id>', 'Only threads with a message in this review round'],
    ],
    examples: ['lhr thread list', 'lhr thread list --whose-turn agent --path src/auth --json'],
  },
  {
    path: ['thread', 'show'],
    summary: 'Show one thread with its messages.',
    usage: 'lhr thread show <id> [flags]',
    args: [['id', 'Thread handle, full ID or unambiguous ID prefix']],
    examples: ['lhr thread show k3m9', 'lhr thread show 20261002T101500Z-k3m9qz --json'],
  },
  {
    path: ['thread', 'create'],
    summary: 'Start a thread.',
    usage: 'lhr thread create <path>[:<line>[-<end>]] [-] [flags]',
    args: [
      ['path', 'File to comment on, optionally with a line or line range'],
      ['-', 'Read the message body from stdin'],
    ],
    flags: [
      ['--body <text>', 'Message body (instead of stdin)'],
      ['--severity <level>', 'Severity of the thread'],
      ['--client-id <id>', 'Idempotency key: a retry with the same id is a no-op'],
    ],
    examples: [
      "lhr thread create src/auth/session.ts:42-47 --severity high - <<'EOF'",
      'lhr thread create README.md --body "Document the new flags" --client-id readme-flags',
    ],
    notes: ['Without --client-id a retry creates a second thread.'],
  },
  {
    path: ['thread', 'reply'],
    summary: 'Add a message to a thread.',
    usage: 'lhr thread reply <id> [-] [flags]',
    args: [
      ['id', 'Thread handle or unambiguous prefix'],
      ['-', 'Read the message body from stdin'],
    ],
    flags: [
      ['--body <text>', 'Message body (instead of stdin)'],
      ['--client-id <id>', 'Idempotency key: a retry with the same id is a no-op'],
    ],
    examples: [
      "lhr thread reply 20261002T1015 - <<'EOF'",
      'lhr thread reply 20261002T1015 --body "Fixed in 3f2a9c1"',
    ],
    notes: ['Without --client-id a retry adds a second message.'],
  },
  {
    path: ['thread', 'resolve'],
    summary: 'Resolve a thread.',
    usage: 'lhr thread resolve <id> [-] [flags]',
    args: [
      ['id', 'Thread handle or unambiguous prefix'],
      ['-', 'Read an optional closing message from stdin'],
    ],
    flags: [['--body <text>', 'Closing message (instead of stdin)']],
    examples: [
      'lhr thread resolve 20261002T1015',
      'lhr thread resolve 20261002T1015 --body "Done in 3f2a9c1"',
    ],
  },
  {
    path: ['thread', 'reopen'],
    summary: 'Reopen a thread.',
    usage: 'lhr thread reopen <id> [-] [flags]',
    args: [
      ['id', 'Thread handle or unambiguous prefix'],
      ['-', 'Read an optional message from stdin'],
    ],
    flags: [['--body <text>', 'Message (instead of stdin)']],
    examples: [
      'lhr thread reopen 20261002T1015',
      'lhr thread reopen 20261002T1015 --body "Still broken on Windows"',
    ],
  },
  {
    path: ['review', 'submit'],
    summary: 'Submit the drafts as a review round (humans only).',
    usage: 'lhr review submit --verdict <v> [-] [flags]',
    args: [['-', 'Read the summary message from stdin']],
    flags: [
      ['--verdict <v>', 'approve or request-changes'],
      ['--body <text>', 'Summary message (instead of stdin)'],
      ['--client-id <id>', 'Idempotency key: a retry with the same id is a no-op'],
    ],
    examples: [
      "lhr review submit --verdict request-changes --client-id pr-42-r1 - <<'EOF'",
      'lhr review submit --verdict approve --dry-run',
    ],
    notes: ['A retry without --client-id writes a second round.'],
  },
  {
    path: ['check'],
    summary: 'Validate the whole .lhr/ tree.',
    usage: 'lhr check [flags]',
    examples: ['lhr check', 'lhr check --json'],
    notes: ['Exit codes: 0 clean, 1 errors found, 2 usage error.'],
  },
  {
    path: ['mcp'],
    summary: 'Run the MCP server on stdio.',
    usage: 'lhr mcp [flags]',
    examples: ['lhr mcp', 'lhr mcp --repo /path/to/repo'],
  },
];

export const GROUPS: Record<string, string> = {
  thread: 'Work with review threads.',
  review: 'Work with review rounds.',
};

const pad = (rows: [string, string][]): string[] => {
  const w = Math.max(...rows.map(([l]) => l.length));
  return rows.map(([l, r]) => `  ${l.padEnd(w)}  ${r}`);
};

export function topLevelHelp(): string {
  const rows: [string, string][] = [
    ['init', 'Create .lhr/ at a directory'],
    ['inbox', "Open, submitted threads where it is the agent's turn"],
    ['thread', 'Work with threads (list, show, create, reply, resolve, reopen)'],
    ['review', 'Work with review rounds (submit)'],
    ['check', 'Validate the whole .lhr/ tree'],
    ['mcp', 'Run the MCP server on stdio'],
  ];
  return [
    'lhr: local human-in-the-loop code review.',
    '',
    'Usage: lhr <command> [flags]',
    '',
    'Commands:',
    ...pad(rows),
    '',
    'Flags:',
    ...pad([...GLOBAL_FLAGS, ['--version', 'Print the version and exit']]),
    '',
    'Examples:',
    '  lhr inbox',
    '  lhr thread list --json',
    '  lhr thread reply --help',
    '',
    'Run lhr <command> --help for details.',
    '',
  ].join('\n');
}

export function groupHelp(group: string): string {
  const verbs = COMMANDS.filter((c) => c.path[0] === group && c.path.length === 2);
  const rows = verbs.map((c): [string, string] => [c.path[1], c.summary]);
  const first = verbs[0].examples[0];
  return [
    GROUPS[group],
    '',
    `Usage: lhr ${group} <command> [flags]`,
    '',
    'Commands:',
    ...pad(rows),
    '',
    'Flags:',
    ...pad(GLOBAL_FLAGS),
    '',
    'Examples:',
    `  ${first}`,
    `  lhr ${group} ${verbs[verbs.length - 1].path[1]} --help`,
    '',
  ].join('\n');
}

export function commandHelp(c: CommandHelp): string {
  const out = [c.summary, '', `Usage: ${c.usage}`, ''];
  if (c.args) out.push('Arguments:', ...pad(c.args), '');
  out.push('Flags:', ...pad([...(c.flags ?? []), ...GLOBAL_FLAGS]), '');
  out.push('Examples:', ...c.examples.map((e) => `  ${e}`), '');
  if (c.notes) out.push('Notes:', ...c.notes.map((n) => `  ${n}`), '');
  return out.join('\n');
}
