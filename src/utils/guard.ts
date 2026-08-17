/**
 * Exception-proof wrappers for callbacks that Zotero invokes WITHOUT any
 * try/catch of its own (ItemPaneManager hooks, MenuManager callbacks…).
 * A throw from a plugin hook aborts Zotero's whole item-pane render loop
 * and takes the native sections down with it — so plugin hooks must never
 * throw. Errors are logged to both the plugin log and Zotero's error
 * console instead.
 */

export function guard<T extends (...args: any[]) => any>(
  name: string,
  fn: T,
): T {
  return ((...args: any[]) => {
    try {
      return fn(...args);
    } catch (e) {
      ztoolkit.log(`[guard] ${name} failed`, e);
      try {
        Zotero.logError(e as any);
      } catch {
        // logging must never throw either
      }
      return undefined;
    }
  }) as T;
}

export function guardAsync<T extends (...args: any[]) => Promise<any>>(
  name: string,
  fn: T,
): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (e) {
      ztoolkit.log(`[guard] ${name} failed`, e);
      try {
        Zotero.logError(e as any);
      } catch {
        // logging must never throw either
      }
      return undefined;
    }
  }) as T;
}
