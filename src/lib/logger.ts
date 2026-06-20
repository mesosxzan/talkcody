import { isTauriRuntime } from '@/lib/runtime-env';

// Console fallback for web mode
const consoleLogger = {
  trace: (msg: string) => console.debug(msg),
  debug: (msg: string) => console.debug(msg),
  info: (msg: string) => console.info(msg),
  warn: (msg: string) => console.warn(msg),
  error: (msg: string) => console.error(msg),
};

// Lazy-loaded Tauri log functions
let tauriLog: typeof import('@tauri-apps/plugin-log') | null = null;
async function getTauriLog() {
  if (!tauriLog) {
    tauriLog = await import('@tauri-apps/plugin-log');
  }
  return tauriLog;
}

export const logger = {
  trace: (message: string, ...args: any[]) => {
    const formattedMessage =
      args.length > 0
        ? `${message} ${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, '\t') : String(arg))).join(' ')}`
        : message;
    if (isTauriRuntime()) {
      return getTauriLog().then((m) => m.trace(formattedMessage));
    }
    consoleLogger.trace(formattedMessage);
  },

  debug: (message: string, ...args: any[]) => {
    const formattedMessage =
      args.length > 0
        ? `${message} ${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, '\t') : String(arg))).join(' ')}`
        : message;
    if (isTauriRuntime()) {
      return getTauriLog().then((m) => m.debug(formattedMessage));
    }
    consoleLogger.debug(formattedMessage);
  },

  info: (message: string, ...args: any[]) => {
    const formattedMessage =
      args.length > 0
        ? `${message} ${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, '\t') : String(arg))).join(' ')}`
        : message;
    if (isTauriRuntime()) {
      return getTauriLog().then((m) => m.info(formattedMessage));
    }
    consoleLogger.info(formattedMessage);
  },

  warn: (message: string, ...args: any[]) => {
    const formattedMessage =
      args.length > 0
        ? `${message} ${args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg, null, '\t') : String(arg))).join(' ')}`
        : message;
    if (isTauriRuntime()) {
      return getTauriLog().then((m) => m.warn(formattedMessage));
    }
    consoleLogger.warn(formattedMessage);
  },

  error: (message: string, ...args: any[]) => {
    const formattedMessage =
      args.length > 0
        ? `${message} ${args
            .map((arg) => {
              if (arg instanceof Error) {
                return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
              }
              if (typeof arg === 'object') {
                return JSON.stringify(arg, null, '\t');
              }
              return String(arg);
            })
            .join(' ')}`
        : message;
    if (isTauriRuntime()) {
      return getTauriLog().then((m) => m.error(formattedMessage));
    }
    consoleLogger.error(formattedMessage);
  },
};
