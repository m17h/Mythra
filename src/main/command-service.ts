import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type { CommandResult } from '@shared/types';

interface RunningJob {
  process: ChildProcessWithoutNullStreams;
}

export class CommandService {
  private readonly jobs = new Map<string, RunningJob>();

  private getShell() {
    const shell = process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';
    const args = process.platform === 'win32' ? ['-Command'] : ['-lc'];
    return { shell, args };
  }

  private killProcessTree(proc: ChildProcessWithoutNullStreams) {
    if (proc.pid == null) {
      return;
    }
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f']);
      return;
    }
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process already exited.
      }
    }
  }

  run(window: BrowserWindow, command: string, cwd?: string) {
    const jobId = randomUUID();
    const { shell, args } = this.getShell();

    const child = spawn(shell, [...args, command], {
      cwd,
      detached: process.platform !== 'win32',
      env: process.env
    });

    this.jobs.set(jobId, { process: child });

    window.webContents.send('commands:chunk', {
      jobId,
      stream: 'system',
      chunk: `$ ${command}\n`
    });

    child.stdout.on('data', (chunk: Buffer) => {
      window.webContents.send('commands:chunk', {
        jobId,
        stream: 'stdout',
        chunk: chunk.toString()
      });
    });

    child.stderr.on('data', (chunk: Buffer) => {
      window.webContents.send('commands:chunk', {
        jobId,
        stream: 'stderr',
        chunk: chunk.toString()
      });
    });

    child.on('close', (code, signal) => {
      this.jobs.delete(jobId);
      const result: CommandResult = { jobId, code, signal };
      window.webContents.send('commands:done', result);
    });

    return { jobId };
  }

  async runAndCapture(command: string, cwd?: string, timeoutMs = 20_000, abortSignal?: AbortSignal) {
    const { shell, args } = this.getShell();

    return new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(shell, [...args, command], {
        cwd,
        detached: process.platform !== 'win32',
        env: process.env
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const finish = (value: { stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve({
          ...value,
          stdout: value.stdout.slice(0, 12_000),
          stderr: value.stderr.slice(0, 12_000)
        });
      };

      const timer = setTimeout(() => {
        timedOut = true;
        this.killProcessTree(child);
        finish({
          stdout,
          stderr: `${stderr}\n[command timed out after ${timeoutMs}ms]`,
          code: null,
          signal: 'SIGTERM'
        });
      }, timeoutMs);

      const abortHandler = () => {
        this.killProcessTree(child);
        finish({
          stdout,
          stderr: `${stderr}\n[command stopped by user]`,
          code: null,
          signal: 'SIGTERM'
        });
      };

      abortSignal?.addEventListener('abort', abortHandler, { once: true });

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', abortHandler);
        if (settled) {
          return;
        }
        settled = true;
        reject(error);
      });

      child.on('close', (code, processSignal) => {
        clearTimeout(timer);
        abortSignal?.removeEventListener('abort', abortHandler);
        if (timedOut) {
          return;
        }
        finish({ stdout, stderr, code, signal: processSignal });
      });
    });
  }

  kill(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return false;
    }

    this.killProcessTree(job.process);
    this.jobs.delete(jobId);
    return true;
  }
}
