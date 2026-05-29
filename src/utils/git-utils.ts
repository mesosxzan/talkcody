import { invoke } from '@tauri-apps/api/core';
import { logger } from '@/lib/logger';

/** Result from the Rust execute_git command */
interface TauriShellResult {
  stdout: string;
  stderr: string;
  code: number;
  timed_out: boolean;
  idle_timed_out: boolean;
  pid: number | null;
}

export interface GitResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Execute a git command using the `execute_git` Tauri command.
 *
 * Unlike shell-based execution, this invokes the git binary directly
 * (no bash/cmd wrapper), which works reliably on all platforms.
 */
async function gitCommand(args: string[], cwd?: string): Promise<GitResult> {
  try {
    const result = await invoke<TauriShellResult>('execute_git', {
      args,
      cwd: cwd ?? null,
      timeoutMs: 30000,
      idleTimeoutMs: 10000,
    });
    return {
      success: result.code === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  } catch (error) {
    return {
      success: false,
      stdout: '',
      stderr: String(error),
    };
  }
}

export async function getGitStatus(cwd: string): Promise<GitResult> {
  return gitCommand(['status', '--porcelain'], cwd);
}

export async function getGitDiff(cwd: string): Promise<GitResult> {
  return gitCommand(['diff'], cwd);
}

export async function getGitDiffStaged(cwd: string): Promise<GitResult> {
  return gitCommand(['diff', '--staged'], cwd);
}

export async function getGitLog(cwd: string, count = 10): Promise<GitResult> {
  return gitCommand(['log', `-${count}`, '--oneline'], cwd);
}

export async function gitAdd(cwd: string, files?: string[]): Promise<GitResult> {
  if (files && files.length > 0) {
    return gitCommand(['add', ...files], cwd);
  }
  return gitCommand(['add', '.'], cwd);
}

export async function gitCommit(cwd: string, message: string): Promise<GitResult> {
  return gitCommand(['commit', '-m', message], cwd);
}

export async function gitPush(cwd: string): Promise<GitResult> {
  return gitCommand(['push'], cwd);
}

export async function gitPull(cwd: string): Promise<GitResult> {
  return gitCommand(['pull'], cwd);
}

export async function gitCheckout(cwd: string, branch: string): Promise<GitResult> {
  return gitCommand(['checkout', branch], cwd);
}

export async function gitBranch(cwd: string): Promise<GitResult> {
  return gitCommand(['branch'], cwd);
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await gitCommand(['rev-parse', '--is-inside-work-tree'], cwd);
  return result.success && result.stdout.trim() === 'true';
}

export async function getGitRemoteUrl(cwd: string): Promise<string> {
  const result = await gitCommand(['remote', 'get-url', 'origin'], cwd);
  return result.success ? result.stdout.trim() : '';
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  const result = await gitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  return result.success ? result.stdout.trim() : '';
}

export async function getUntrackedFiles(cwd: string): Promise<string[]> {
  const result = await gitCommand(['status', '--porcelain', '-u'], cwd);
  if (!result.success) return [];

  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('??'))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

export async function deleteUntrackedFiles(cwd: string, files: string[]): Promise<GitResult> {
  if (files.length === 0) {
    return { success: true, stdout: '', stderr: '' };
  }

  // Use git clean -f for untracked files
  return gitCommand(['clean', '-f', '--', ...files], cwd);
}

/**
 * Add files and commit in one operation.
 * @deprecated Use gitAdd() + gitCommit() separately for more control.
 */
export async function gitAddAndCommit(
  cwd: string,
  message: string,
  files?: string[]
): Promise<{ success: boolean; message: string; output: string; error: string }> {
  const addResult = await gitAdd(cwd, files);
  if (!addResult.success) {
    return {
      success: false,
      message: 'git add failed',
      output: addResult.stdout,
      error: addResult.stderr,
    };
  }

  const commitResult = await gitCommit(cwd, message);
  return {
    success: commitResult.success,
    message: commitResult.success ? 'Committed successfully' : 'git commit failed',
    output: commitResult.stdout,
    error: commitResult.stderr,
  };
}
