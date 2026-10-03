// `lhr mcp` command: serves MCP on stdio until stdin closes.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Command } from '../commands.js';
import { warn } from '../output.js';
import { createLhrServer } from './server.js';

declare const __LHR_VERSION__: string;

export const mcpCommand: Command = {
  // The server always starts; the review root is resolved per tool call.
  needsRoot: false,
  async run(ctx) {
    for (const flag of ['as', 'name', 'json', 'dry-run']) {
      if (ctx.values[flag] !== undefined) warn(`--${flag} is ignored by lhr mcp`);
    }
    const { server, dispose } = createLhrServer({
      start: ctx.start,
      env: process.env,
      version: __LHR_VERSION__,
    });
    const transport = new StdioServerTransport();
    const closed = new Promise<void>((done) => {
      transport.onclose = done;
    });
    await server.connect(transport);
    process.stdin.once('end', () => void server.close());
    await closed;
    await dispose();
  },
};
