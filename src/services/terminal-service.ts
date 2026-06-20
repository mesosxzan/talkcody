import type { Terminal } from '@xterm/xterm';
import stripAnsi from 'strip-ansi';
import { logger } from '@/lib/logger';
import { getRuntimeApiUrl, isTauriRuntime, tauriInvoke, tauriListen } from '@/lib/runtime-env';
import { settingsManager } from '@/stores/settings-store';
import { type TerminalSession, useTerminalStore } from '@/stores/terminal-store';

interface PtySpawnResult {
  pty_id: string;
}

interface PtyOutput {
  pty_id: string;
  data: string;
}

interface PtyCloseEvent {
  pty_id: string;
}

// WebSocket message types for web mode
type WsClientMessage =
  | {
      type: 'spawn';
      requestId: string;
      cwd?: string;
      cols: number;
      rows: number;
      preferredShell: string | null;
    }
  | { type: 'write'; ptyId: string; data: string }
  | { type: 'resize'; ptyId: string; cols: number; rows: number }
  | { type: 'kill'; ptyId: string };

type WsServerMessage =
  | { type: 'spawned'; requestId: string; ptyId: string }
  | { type: 'output'; ptyId: string; data: string }
  | { type: 'close'; ptyId: string }
  | { type: 'error'; message: string; ptyId?: string };

class TerminalService {
  private listeners: Map<string, () => void> = new Map();
  private outputListener: (() => void) | null = null;
  private closeListener: (() => void) | null = null;
  private dataListeners: Map<string, { dispose: () => void }> = new Map();
  // Buffer for outputs that arrive before session is created (race condition fix)
  private pendingOutputs: Map<string, string[]> = new Map();

  // WebSocket-related state for web mode
  private ws: WebSocket | null = null;
  private wsConnecting: Promise<void> | null = null;
  private spawnResolvers: Map<
    string,
    { resolve: (ptyId: string) => void; reject: (error: Error) => void }
  > = new Map();

  async initialize(): Promise<void> {
    logger.info('Initializing Terminal Service');

    if (isTauriRuntime()) {
      await this.initializeTauri();
    } else {
      await this.initializeWebSocket();
    }
  }

  private async initializeTauri(): Promise<void> {
    // Check if already initialized
    if (this.outputListener || this.closeListener) {
      logger.warn('Terminal Service already initialized, skipping', {
        hasOutputListener: !!this.outputListener,
        hasCloseListener: !!this.closeListener,
      });
      return;
    }

    // Listen for PTY output
    this.outputListener = await tauriListen<PtyOutput>('pty-output', ({ pty_id, data }) => {
      this.handlePtyOutput(pty_id, data);
    });
    logger.info('PTY output listener registered');

    // Listen for PTY close events
    this.closeListener = await tauriListen<PtyCloseEvent>('pty-close', ({ pty_id }) => {
      this.handlePtyClose(pty_id);
    });
    logger.info('PTY close listener registered');

    logger.info('Terminal Service initialized (Tauri mode)');
  }

  private async initializeWebSocket(): Promise<void> {
    await this.ensureWsConnected();
    logger.info('Terminal Service initialized (WebSocket mode)');
  }

  private async ensureWsConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.wsConnecting) {
      await this.wsConnecting;
      return;
    }

    this.wsConnecting = new Promise<void>((resolve, reject) => {
      const wsUrl = getRuntimeApiUrl('/api/terminal/ws').replace(/^http/, 'ws');

      logger.info('Connecting to terminal WebSocket', { wsUrl });
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        logger.info('Terminal WebSocket connected');
        resolve();
      };

      ws.onerror = (event) => {
        logger.error('Terminal WebSocket error', { event });
        reject(new Error('WebSocket connection failed'));
      };

      ws.onclose = () => {
        logger.info('Terminal WebSocket closed');
        if (this.ws === ws) {
          this.ws = null;
          // Mark all active sessions as inactive
          const store = useTerminalStore.getState();
          for (const session of store.sessions.values()) {
            if (session.isActive) {
              store.updateSession(session.id, { isActive: false });
              if (session.terminal) {
                session.terminal.write('\r\n\x1b[33m[Connection lost]\x1b[0m\r\n');
              }
            }
          }
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as WsServerMessage;
          this.handleWsMessage(msg);
        } catch (e) {
          logger.error('Failed to parse WebSocket message', { error: e });
        }
      };

      this.ws = ws;
    });

    try {
      await this.wsConnecting;
    } finally {
      this.wsConnecting = null;
    }
  }

  private handleWsMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case 'spawned': {
        const resolver = this.spawnResolvers.get(msg.requestId);
        if (resolver) {
          this.spawnResolvers.delete(msg.requestId);
          resolver.resolve(msg.ptyId);
        }
        break;
      }
      case 'output': {
        this.handlePtyOutput(msg.ptyId, msg.data);
        break;
      }
      case 'close': {
        this.handlePtyClose(msg.ptyId);
        break;
      }
      case 'error': {
        logger.error('Terminal WebSocket error from server', {
          message: msg.message,
          ptyId: msg.ptyId,
        });
        // If there's a pending spawn for this pty, reject it
        if (msg.ptyId) {
          const resolver = this.spawnResolvers.get(msg.ptyId);
          if (resolver) {
            this.spawnResolvers.delete(msg.ptyId);
            resolver.reject(new Error(msg.message));
          }
        }
        break;
      }
    }
  }

  private wsSend(msg: WsClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.error('Cannot send message: WebSocket not connected');
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  async cleanup(): Promise<void> {
    logger.info('Cleaning up Terminal Service');

    // Remove all listeners
    for (const unlisten of this.listeners.values()) {
      unlisten();
    }
    this.listeners.clear();

    if (this.outputListener) {
      this.outputListener();
      this.outputListener = null;
    }

    if (this.closeListener) {
      this.closeListener();
      this.closeListener = null;
    }

    // Clear pending outputs buffer
    this.pendingOutputs.clear();

    // Kill all active sessions
    const store = useTerminalStore.getState();
    const sessions = Array.from(store.sessions.values());

    for (const session of sessions) {
      await this.killTerminal(session.ptyId);
    }

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    logger.info('Terminal Service cleaned up');
  }

  async createTerminal(cwd?: string, cols = 80, rows = 24): Promise<TerminalSession> {
    try {
      // Get user's preferred shell from settings
      const preferredShell = settingsManager.getTerminalShell();
      logger.info('Creating new terminal', { cwd, cols, rows, preferredShell });

      if (isTauriRuntime()) {
        return this.createTerminalTauri(cwd, cols, rows, preferredShell);
      } else {
        return this.createTerminalWs(cwd, cols, rows, preferredShell);
      }
    } catch (error) {
      logger.error('Failed to create terminal', error);
      throw error;
    }
  }

  private async createTerminalTauri(
    cwd?: string,
    cols = 80,
    rows = 24,
    preferredShell?: string
  ): Promise<TerminalSession> {
    const result = await tauriInvoke<PtySpawnResult>('pty_spawn', {
      cwd,
      cols,
      rows,
      preferredShell: preferredShell === 'auto' ? null : preferredShell,
    });

    const session: TerminalSession = {
      id: crypto.randomUUID(),
      ptyId: result.pty_id,
      title: cwd ? `Terminal - ${cwd.split(/[/\\]/).pop()}` : 'Terminal',
      cwd,
      buffer: '',
      isActive: true,
      createdAt: new Date(),
    };

    useTerminalStore.getState().addSession(session);
    logger.info('Terminal created (Tauri)', { sessionId: session.id, ptyId: session.ptyId });

    // Flush any pending outputs that arrived before session was created (race condition fix for Windows)
    const pendingData = this.pendingOutputs.get(result.pty_id);
    if (pendingData && pendingData.length > 0) {
      logger.info('Flushing pending outputs after session creation', {
        ptyId: result.pty_id,
        sessionId: session.id,
        pendingChunks: pendingData.length,
      });
      // Process pending outputs after a short delay to ensure terminal is ready
      setTimeout(() => {
        for (const data of pendingData) {
          this.handlePtyOutput(result.pty_id, data);
        }
      }, 50);
      this.pendingOutputs.delete(result.pty_id);
    }

    return session;
  }

  private async createTerminalWs(
    cwd?: string,
    cols = 80,
    rows = 24,
    preferredShell?: string
  ): Promise<TerminalSession> {
    await this.ensureWsConnected();

    // Use a requestId to correlate the spawn request with the spawned response
    const requestId = crypto.randomUUID();

    return new Promise<TerminalSession>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.spawnResolvers.delete(requestId);
        reject(new Error('Terminal spawn timed out'));
      }, 10000);

      this.spawnResolvers.set(requestId, {
        resolve: (serverPtyId: string) => {
          clearTimeout(timeout);

          const session: TerminalSession = {
            id: crypto.randomUUID(),
            ptyId: serverPtyId,
            title: cwd ? `Terminal - ${cwd.split(/[/\\]/).pop()}` : 'Terminal',
            cwd,
            buffer: '',
            isActive: true,
            createdAt: new Date(),
          };

          useTerminalStore.getState().addSession(session);
          logger.info('Terminal created (WebSocket)', {
            sessionId: session.id,
            ptyId: session.ptyId,
          });

          // Flush any pending outputs
          const pendingData = this.pendingOutputs.get(serverPtyId);
          if (pendingData && pendingData.length > 0) {
            setTimeout(() => {
              for (const data of pendingData) {
                this.handlePtyOutput(serverPtyId, data);
              }
            }, 50);
            this.pendingOutputs.delete(serverPtyId);
          }

          resolve(session);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      this.wsSend({
        type: 'spawn',
        requestId,
        cwd,
        cols,
        rows,
        preferredShell: preferredShell === 'auto' ? null : preferredShell || null,
      });
    });
  }

  async writeToTerminal(ptyId: string, data: string): Promise<void> {
    try {
      logger.info('Writing to PTY', { ptyId, data, dataLength: data.length });

      if (isTauriRuntime()) {
        await tauriInvoke('pty_write', { ptyId, data });
      } else {
        this.wsSend({ type: 'write', ptyId, data });
      }
    } catch (error) {
      logger.error('Failed to write to terminal', { ptyId, error });
      throw error;
    }
  }

  async resizeTerminal(ptyId: string, cols: number, rows: number): Promise<void> {
    try {
      if (isTauriRuntime()) {
        await tauriInvoke('pty_resize', { ptyId, cols, rows });
      } else {
        this.wsSend({ type: 'resize', ptyId, cols, rows });
      }
    } catch (error) {
      logger.error('Failed to resize terminal', { ptyId, cols, rows, error });
      // Don't throw, resize is not critical
    }
  }

  async killTerminal(ptyId: string): Promise<void> {
    try {
      logger.info('Killing terminal', { ptyId });

      if (isTauriRuntime()) {
        await tauriInvoke('pty_kill', { ptyId });
      } else {
        this.wsSend({ type: 'kill', ptyId });
      }

      // Remove session from store
      const store = useTerminalStore.getState();
      const session = Array.from(store.sessions.values()).find((s) => s.ptyId === ptyId);

      if (session) {
        // Clean up data listener
        const dataListener = this.dataListeners.get(session.id);
        if (dataListener) {
          dataListener.dispose();
          this.dataListeners.delete(session.id);
        }

        store.removeSession(session.id);
      }
    } catch (error) {
      logger.error('Failed to kill terminal', { ptyId, error });
      throw error;
    }
  }

  attachTerminal(sessionId: string, terminal: Terminal): void {
    const store = useTerminalStore.getState();
    const session = store.getSession(sessionId);

    if (!session) {
      logger.error('Session not found for attachment', { sessionId });
      return;
    }

    // Clean up any existing listeners and terminal references
    const existingListener = this.dataListeners.get(sessionId);
    if (existingListener) {
      logger.warn('Disposing existing data listener before re-attachment', { sessionId });
      existingListener.dispose();
      this.dataListeners.delete(sessionId);
    }

    // Warn if a different terminal instance is already attached
    if (session.terminal && session.terminal !== terminal) {
      logger.warn('Different terminal instance already attached to session', { sessionId });
    }

    store.updateSession(sessionId, { terminal });

    // Write any buffered output that arrived before terminal was attached
    if (session.buffer) {
      logger.info('Writing buffered output to newly attached terminal', {
        sessionId,
        bufferLength: session.buffer.length,
      });
      terminal.write(session.buffer);
    }

    // Set up data handler for user input
    let callCount = 0;
    const disposable = terminal.onData((data) => {
      callCount++;
      logger.info('onData triggered', { sessionId, data, callCount, ptyId: session.ptyId });
      this.writeToTerminal(session.ptyId, data);
    });

    // Store the disposable for cleanup
    this.dataListeners.set(sessionId, disposable);

    logger.info('Terminal attached', {
      sessionId,
      ptyId: session.ptyId,
      totalListeners: this.dataListeners.size,
    });
  }

  detachTerminal(sessionId: string): void {
    // Clean up data listener
    const dataListener = this.dataListeners.get(sessionId);
    if (dataListener) {
      dataListener.dispose();
      this.dataListeners.delete(sessionId);
      logger.info('Terminal detached', { sessionId });
    }

    // Clear terminal reference from session
    const store = useTerminalStore.getState();
    store.updateSession(sessionId, { terminal: undefined });
  }

  private handlePtyOutput(ptyId: string, data: string): void {
    const store = useTerminalStore.getState();
    const session = Array.from(store.sessions.values()).find((s) => s.ptyId === ptyId);

    if (!session) {
      // Buffer early outputs that arrive before session is created (race condition fix for Windows)
      const pending = this.pendingOutputs.get(ptyId) || [];
      pending.push(data);
      this.pendingOutputs.set(ptyId, pending);
      logger.info('Buffered early PTY output (session not yet created)', {
        ptyId,
        dataLength: data.length,
        totalPendingChunks: pending.length,
      });
      return;
    }

    logger.info('handlePtyOutput received', {
      ptyId,
      sessionId: session.id,
      data,
      dataLength: data.length,
      hasTerminal: !!session.terminal,
    });

    // Write to terminal
    if (session.terminal) {
      session.terminal.write(data);
      logger.info('Wrote to XTerm', { sessionId: session.id, data });
    }

    // Append to buffer for "copy to chat" feature
    store.appendToBuffer(session.id, data);
  }

  private closedPtys: Set<string> = new Set();

  private handlePtyClose(ptyId: string): void {
    // Prevent duplicate close handling
    if (this.closedPtys.has(ptyId)) {
      return;
    }
    this.closedPtys.add(ptyId);

    logger.info('PTY closed', { ptyId });

    const store = useTerminalStore.getState();
    const session = Array.from(store.sessions.values()).find((s) => s.ptyId === ptyId);

    if (session) {
      // Optionally show a message in the terminal
      if (session.terminal) {
        session.terminal.write('\r\n\x1b[33m[Process completed]\x1b[0m\r\n');
      }

      // Mark as inactive
      store.updateSession(session.id, { isActive: false });
    }

    // Clean up after a delay to prevent memory leak
    setTimeout(() => {
      this.closedPtys.delete(ptyId);
    }, 5000);
  }

  getSessionBuffer(sessionId: string): string {
    const store = useTerminalStore.getState();
    const session = store.getSession(sessionId);
    return session?.buffer || '';
  }

  getRecentCommands(sessionId: string, lines = 50): string {
    const buffer = this.getSessionBuffer(sessionId);
    const allLines = buffer.split('\n');
    const recentLines = allLines.slice(-lines);
    const cleanText = recentLines.join('\n');
    return stripAnsi(cleanText);
  }
}

export const terminalService = new TerminalService();
