/**
 * Console logging bootstrap for React Native
 *
 * Control flow:
 *
 * console.log("msg", obj)
 * │
 * ├─ consoleOutputEnabled = false? (default for prod)
 * │  └─ return immediately ⛔  (zero cost, args untouched)
 * │
 * ├─ consoleOutputEnabled = true? (default for dev/preview, or toggled on)
 * │  ├─ call original console method ✅
 * │  ├─ capture to in-app buffer ✅
 * │  └─ send to remote log server (if configured) ✅
 * │
 * └─ console.error / console.warn (always, regardless of flag)
 *    ├─ call original console method ✅
 *    ├─ capture to in-app buffer ✅
 *    └─ send to remote log server (if configured) ✅
 */

import { log } from '@/log';
import { MAX_APP_LOG_ENTRIES } from '@/log';
import { getLogServerUrl } from '@/sync/serverConfig';
import { loadLocalSettings } from '@/sync/persistence';
import { loadAppConfig } from '@/sync/appConfig';
import { Platform } from 'react-native';
import { serializeForLogs } from '@/utils/truncateForLogs';

/**
 * Mirror console output into a file when running inside the desktop shell.
 *
 * A Windows GUI build has no console attached and no terminal to attach one to,
 * so a log that is only printed is a log that is lost — which made every
 * desktop-only bug a matter of reproducing it blind. The Rust side registers
 * `tauri-plugin-log` with a LogDir target; this forwards the webview's console
 * to it, because that is where the app's diagnostics actually go.
 *
 * Two details make this safe to leave on:
 *
 *  - Re-entrancy. `invoke` logs a warning of its own when it fails, and that
 *    warning arrives at the patched console and would be forwarded straight
 *    back into another failing invoke. The guard breaks that cycle.
 *  - Lazy import. `@tauri-apps/api` must not be pulled into the mobile bundles,
 *    where it is dead weight, so it is required only on first use and only
 *    after the Tauri global has been seen.
 */
let desktopLoggingEnabled = false;
let desktopForwardInFlight = false;
/**
 * Pending lines, oldest first. Bounded so a render loop cannot grow it without
 * limit, and ordered so the file reads in the sequence things happened rather
 * than the order the IPC happened to complete in.
 */
const desktopQueue: Array<[string, string]> = [];
const DESKTOP_QUEUE_LIMIT = 500;

/** Rust `log` crate levels, as the plugin's command expects them. */
const LOG_LEVEL_TO_NUMBER: Record<string, number> = {
  trace: 1,
  debug: 2,
  log: 3,
  info: 3,
  warn: 4,
  error: 5,
};

function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function forwardToDesktopLog(level: string, message: string): void {
  if (!desktopLoggingEnabled) return;

  // Overflow drops the oldest line, not the newest: when something has gone
  // wrong, the recent past is what explains it.
  desktopQueue.push([level, message]);
  if (desktopQueue.length > DESKTOP_QUEUE_LIMIT) {
    desktopQueue.shift();
  }
  drainDesktopQueue();
}

function drainDesktopQueue(): void {
  if (desktopForwardInFlight || desktopQueue.length === 0) return;
  desktopForwardInFlight = true;
  void (async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      // Drained one line at a time so the file keeps its order, and re-read
      // each iteration because the queue keeps filling while this runs.
      while (desktopQueue.length > 0) {
        const [level, message] = desktopQueue.shift()!;
        await invoke('plugin:log|log', {
          level: LOG_LEVEL_TO_NUMBER[level] ?? 3,
          message,
        });
      }
    } catch {
      // Nothing to do and nowhere to say it: reporting the failure would mean
      // calling console again, which is the loop this guard exists to break.
      desktopQueue.length = 0;
    } finally {
      desktopForwardInFlight = false;
    }
  })();
}

let logBuffer: any[] = []
const MAX_BUFFER_SIZE = MAX_APP_LOG_ENTRIES
let isConsolePatched = false
let remoteLogServerUrl: string | null = null
let consoleOutputEnabled = false
let originalConsole: {
  log: typeof console.log,
  info: typeof console.info,
  warn: typeof console.warn,
  error: typeof console.error,
  debug: typeof console.debug,
} | null = null

/**
 * Toggle console output at runtime (e.g. from Dev screen toggle).
 */
export function setConsoleOutputEnabled(enabled: boolean) {
  consoleOutputEnabled = enabled
}

export function initConsoleLogging() {
  if (isConsolePatched) {
    return
  }

  remoteLogServerUrl = getLogServerUrl();
  desktopLoggingEnabled = isDesktopShell();

  // Determine initial state: user setting > build variant default > off
  try {
    const settings = loadLocalSettings();
    const config = loadAppConfig();
    consoleOutputEnabled = settings.consoleLoggingEnabled || config.consoleLoggingDefault || false;
  } catch {
    consoleOutputEnabled = false;
  }

  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  log.setConsoleCaptureEnabled(true)

  function formatArgs(args: any[]): string {
    return args.map(a => {
      if (a === null || a === undefined) return String(a)
      if (typeof a !== 'object') return serializeForLogs(a)
      try { return serializeForLogs(a) } catch { return String(a) }
    }).join(' ')
  }

  function sendLog(level: string, formatted: string) {
    if (!remoteLogServerUrl) {
      return
    }

    void fetch(remoteLogServerUrl + '/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message: formatted,
        source: 'mobile',
        platform: Platform.OS,
      })
    }).catch(() => {})
  }

  // Patch console methods
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    const alwaysPassThrough = level === 'error' || level === 'warn'

    console[level] = (...args: any[]) => {
      const enabled = consoleOutputEnabled || alwaysPassThrough

      // Full short-circuit: when off, skip everything for log/info/debug. On
      // desktop the file mirror below still runs, because the levels this
      // suppresses are exactly the diagnostics a release build needs to keep —
      // there is no console window to have watched them in.
      if (!enabled && !desktopLoggingEnabled) {
        return
      }

      // Pass raw args to native console (preserves interactive object inspection,
      // clickable stack traces, and multi-arg formatting in dev tools)
      if (enabled) {
        originalConsole![level](...args)
      }

      // Serialize once for buffer + remote (but NOT for native console)
      const formatted = formatArgs(args)
      forwardToDesktopLog(level, formatted)

      if (!enabled) {
        return
      }

      log.captureFormatted(level, formatted)

      logBuffer.push({
        timestamp: new Date().toISOString(),
        level,
        message: formatted
      })
      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift()
      }

      sendLog(level, formatted)
    }
  })

  isConsolePatched = true

  originalConsole.log('[ConsoleLogging] Initialized', consoleOutputEnabled ? '(output enabled)' : '(output suppressed)')
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
