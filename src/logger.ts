import * as vscode from 'vscode';

export const outputChannel = vscode.window.createOutputChannel('Local HITL Review');

export function log(message: string): void {
  const timestamp = new Date().toISOString();
  outputChannel.appendLine(`[${timestamp}] ${message}`);
}

export function error(message: string, err?: unknown): void {
  const timestamp = new Date().toISOString();
  let errMsg = '';
  if (err instanceof Error) {
    errMsg = err.message + (err.stack ? `\n${err.stack}` : '');
  } else if (err !== undefined) {
    errMsg = String(err);
  }
  outputChannel.appendLine(`[${timestamp}] ERROR: ${message}${errMsg ? ' - ' + errMsg : ''}`);
}
