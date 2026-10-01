import * as path from 'node:path';
import type { FeedbackComment } from './types.js';

export function generateAgentPrompt(
  workspaceRoot: string,
  agentsFilePath: string,
  allComments: FeedbackComment[]
): string {
  const relative = path.relative(workspaceRoot, agentsFilePath).replace(/\\/g, '/');
  
  const openComments = allComments.filter(c => c.status === 'open');
  if (openComments.length === 0) {
    return `@${relative}`;
  }

  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;

  const fileStats = new Map<string, { critical: number; high: number; medium: number; low: number }>();

  for (const c of openComments) {
    if (c.severity === 'critical') critical++;
    else if (c.severity === 'high') high++;
    else if (c.severity === 'medium') medium++;
    else if (c.severity === 'low') low++;

    let stats = fileStats.get(c.file);
    if (!stats) {
      stats = { critical: 0, high: 0, medium: 0, low: 0 };
      fileStats.set(c.file, stats);
    }
    
    if (c.severity === 'critical') stats.critical++;
    else if (c.severity === 'high') stats.high++;
    else if (c.severity === 'medium') stats.medium++;
    else if (c.severity === 'low') stats.low++;
  }

  const numFiles = fileStats.size;
  const numFindings = openComments.length;

  let prompt = `Review feedback: ${critical} critical, ${high} high, ${medium} medium, ${low} low — ${numFindings} open finding${numFindings === 1 ? '' : 's'} across ${numFiles} file${numFiles === 1 ? '' : 's'}\n\n`;

  // Add file list
  const sortedFiles = Array.from(fileStats.keys()).sort();
  for (const file of sortedFiles) {
    const stats = fileStats.get(file)!;
    const parts: string[] = [];
    if (stats.critical > 0) parts.push(`${stats.critical} critical`);
    if (stats.high > 0) parts.push(`${stats.high} high`);
    if (stats.medium > 0) parts.push(`${stats.medium} medium`);
    if (stats.low > 0) parts.push(`${stats.low} low`);
    prompt += `- ${file} (${parts.join(', ')})\n`;
  }

  prompt += `\n@${relative}`;
  
  return prompt;
}
