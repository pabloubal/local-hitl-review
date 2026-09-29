import type { Severity, Status } from "./types.js";

interface Disposable {
  dispose(): void;
}

export class FilterState {
  private _listeners = new Set<() => void>();

  /**
   * Register a listener for filter changes. Returns a Disposable
   * that unregisters the listener when disposed.
   * Compatible with vscode.Event consumer pattern.
   */
  readonly onDidChange = (listener: () => void): Disposable => {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  };

  public severities = new Set<Severity>();
  public statuses = new Set<Status>(["open"]);

  public update(severities: Severity[], statuses: Status[]) {
    this.severities = new Set(severities);
    this.statuses = new Set(statuses);
    for (const listener of this._listeners) {
      listener();
    }
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
