// src/lib/git-shell.ts
/**
 * Cross-platform Git command execution utility.
 *
 * Uses the Tauri `execute_git` command which invokes the git binary directly
 * (no shell wrapper). This ensures:
 * - No bash dependency on Windows (git.exe invoked directly)
 * - No shell injection risk (args passed as array, not shell string)
 * - No quote escaping issues with cmd.exe
 *
 * For shell commands that need pipes/redirects/&&, use `shellCommand: true`
 * which falls back to `execute_user_shell` (bash -c on Unix, cmd /C on Windows).
 */

import { isTauriRuntime, tauriInvoke } from '@/lib/runtime-env';
import { postJson } from '@/lib/web-platform';

/** Result of a git command execution */
export interface GitShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Result shape from Rust backend execute_git / execute_user_shell */
interface TauriShellResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
  idle_timed_out: boolean;
  pid: number | null;
}

/**
 * Execute a git command with cross-platform handling.
 *
 * @param args     - Git sub-command and arguments (e.g. `['add', '.']`)
 * @param options  - Optional execution options
 * @param options.cwd - Working directory for the command
 * @param options.shellCommand - When true, runs through shell wrapper (for pipes/redirects)
 *
 * @example
 * ```ts
 * // Simple git command — invokes git binary directly
 * const result = await runGitCommand(['status']);
 *
 * // With working directory
 * const result = await runGitCommand(['add', '.'], { cwd: '/path/to/repo' });
 *
 * // Shell command (needs pipes, &&, etc.) — falls back to execute_user_shell
 * const result = await runGitCommand(['log --oneline | head -5'], { shellCommand: true });
 * ```
 */
export async function runGitCommand(
  args: string[],
  options?: { cwd?: string; shellCommand?: boolean }
): Promise<GitShellResult> {
  const { cwd, shellCommand } = options ?? {};

  if (!isTauriRuntime()) {
    const commandString = ['git', ...args].join(' ');
    const result = await postJson<GitShellResult>('/api/platform/git', {
      command: shellCommand ? 'execute_user_shell' : 'execute_git',
      args: { command: commandString, args, cwd: cwd ?? null },
    });
    return result;
  }

  if (shellCommand) {
    // Complex shell command — fall back to execute_user_shell for shell features
    const commandString = ['git', ...args].join(' ');
    const result = await tauriInvoke<TauriShellResult>('execute_user_shell', {
      command: commandString,
      cwd: cwd ?? null,
      timeoutMs: 30000,
      idleTimeoutMs: 10000,
    });
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  // Simple git command — invoke git binary directly (no shell wrapper)
  const result = await tauriInvoke<TauriShellResult>('execute_git', {
    args,
    cwd: cwd ?? null,
    timeoutMs: 30000,
    idleTimeoutMs: 10000,
  });

  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
