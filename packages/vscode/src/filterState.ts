import * as vscode from "vscode";
import { Severity, Status } from "./types.js";

export class FilterState {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  public severities = new Set<Severity>();
  public statuses = new Set<Status>(["open"]);

  public update(severities: Severity[], statuses: Status[]) {
    this.severities = new Set(severities);
    this.statuses = new Set(statuses);
    this._onDidChange.fire();
  }

  public matches(severity: Severity, status: Status): boolean {
    if (this.severities.size > 0 && !this.severities.has(severity)) {
      return false;
    }
    if (this.statuses.size > 0 && !this.statuses.has(status)) {
      return false;
    }
    return true;
  }
}

export const filterState = new FilterState();
