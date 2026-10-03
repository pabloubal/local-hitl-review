// `lhr mcp`: one MCP server per review root (docs/spec/mcp.md). Uses the
// low-level SDK Server so the tool capability stays `tools: {}` (no
// listChanged) and schema failures become our own INVALID_INPUT results.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { openTree, type Author, type Host, type LhrTree } from '../../../core/src/index.js';
import { discoverRoot } from '../context.js';
import { CliError, describeError, type ErrorDetails } from '../errors.js';
import { ENVELOPE_VERSION, successEnvelope } from '../output.js';
import { TOOLS, type ToolContext, type ToolDef } from './tools.js';

export const DEFAULT_MCP_AGENT_NAME = 'mcp-agent';

export const INSTRUCTIONS = [
  'Review loop: inbox -> thread_show -> thread_reply or thread_resolve.',
  'Act on threads where whoseTurn is "agent".',
  'Pass clientId on thread_reply and thread_create so a retry is safe.',
  'You cannot submit reviews or see drafts.',
  'The user creates the review store; if a tool says there is no .lhr/, tell the user to run `lhr init`.',
].join('\n');

const present = (s: string | undefined): string | undefined => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** `LHR_AGENT_NAME` > `clientInfo.name` > `mcp-agent`; blank counts as absent. */
export function mcpAgentName(env: NodeJS.ProcessEnv, clientName: string | undefined): string {
  return present(env.LHR_AGENT_NAME) ?? present(clientName) ?? DEFAULT_MCP_AGENT_NAME;
}

/** `LHR_SESSION_ID`, else `CLAUDE_CODE_SESSION_ID`; never fabricated. */
export function mcpSession(env: NodeJS.ProcessEnv): string | undefined {
  return present(env.LHR_SESSION_ID) ?? present(env.CLAUDE_CODE_SESSION_ID);
}

export interface McpErrorBody {
  code: string;
  message: string;
  example?: string;
}

const call = (tool: string, args: Record<string, unknown>) => `${tool} ${JSON.stringify(args)}`;

/** Maps anything thrown to `{code, message, example?}`; examples are tool calls, never `lhr ...`. */
export function toolError(err: unknown, tool: ToolDef, extra: ErrorDetails = {}): McpErrorBody {
  const own = err instanceof CliError ? (err.opts.details ?? {}) : {};
  const d: ErrorDetails = { ...extra, ...own };
  const e = describeError(err, d);
  let example: string | undefined;
  switch (e.code) {
    case 'INVALID_INPUT':
      example = call(tool.name, tool.example(d));
      break;
    case 'THREAD_NOT_FOUND':
      example = call('thread_list', { status: 'open' });
      break;
    case 'MESSAGE_NOT_FOUND':
      if (d.threadId) example = call('thread_show', { id: d.threadId });
      break;
    case 'PATH_NOT_IN_REPO':
      if (d.path) example = call('thread_create', { path: d.path, line: 1 });
      break;
  }
  const out: McpErrorBody = { code: e.code, message: e.message };
  if (example) out.example = example;
  return out;
}

const errorResult = (body: McpErrorBody): CallToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ version: ENVELOPE_VERSION, error: body }) }],
  isError: true,
});

const issues = (e: z.ZodError): string =>
  e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');

const jsonSchema = (s: z.ZodType, io: 'input' | 'output') =>
  z.toJSONSchema(s, { target: 'draft-7', io }) as { type: 'object'; [k: string]: unknown };

export interface LhrServerOptions {
  /** Where root discovery starts (`--repo`, `LHR_REPO` or cwd). */
  start: string;
  env: NodeJS.ProcessEnv;
  version: string;
  /** Test seam: clock and random source for the trees this server opens. */
  host?: Omit<Host, 'root'>;
}

export interface LhrServer {
  server: Server;
  /** Disposes every open tree. Idempotent. */
  dispose(): Promise<void>;
}

export function createLhrServer(opts: LhrServerOptions): LhrServer {
  const { start, env } = opts;
  const session = mcpSession(env);
  const server = new Server(
    { name: 'lhr', version: opts.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  const trees = new Map<string, Promise<LhrTree>>();
  let disposed: Promise<void> | undefined;

  const ctx: ToolContext = {
    session,
    async open() {
      let root: string;
      try {
        root = discoverRoot(start);
      } catch {
        throw new CliError(
          'NOT_A_REPO',
          `no .lhr/ found from ${start}; ask the user to run \`lhr init\` (agents cannot create the review store)`,
        );
      }
      // A tree opened after dispose would keep its git process, and so the process, alive.
      if (disposed) throw new CliError('IO_FAILED', 'the lhr mcp server is shutting down');
      let tree = trees.get(root);
      if (!tree) {
        tree = openTree({ ...opts.host, root });
        trees.set(root, tree);
        tree.catch(() => trees.delete(root));
      }
      return { root, tree: await tree };
    },
    author(): Author {
      const author: Author = {
        kind: 'agent',
        name: mcpAgentName(env, server.getClientVersion()?.name),
      };
      if (session) author.session = session;
      return author;
    },
  };

  const byName = new Map(TOOLS.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: jsonSchema(t.input, 'input'),
      outputSchema: jsonSchema(t.output, 'output'),
      annotations: t.annotations,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const tool = byName.get(req.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `unknown tool ${req.params.name}`);
    const raw = req.params.arguments ?? {};
    const extra: ErrorDetails = typeof raw.path === 'string' ? { path: raw.path } : {};
    const parsed = tool.input.safeParse(raw);
    if (!parsed.success) {
      return errorResult(
        toolError(
          new CliError(
            'INVALID_INPUT',
            `invalid arguments for ${tool.name}: ${issues(parsed.error)}`,
          ),
          tool,
          extra,
        ),
      );
    }
    try {
      const out = await tool.run(ctx, parsed.data as never);
      const envelope = successEnvelope(out.root, out.data, [...out.diagnostics]);
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope) }],
        structuredContent: envelope as Record<string, unknown>,
      };
    } catch (err) {
      return errorResult(toolError(err, tool, extra));
    }
  });

  const dispose = () =>
    (disposed ??= (async () => {
      const open = [...trees.values()];
      trees.clear();
      await Promise.all(open.map((p) => p.then((t) => t.dispose()).catch(() => undefined)));
    })());
  server.onclose = () => void dispose();

  return { server, dispose };
}
