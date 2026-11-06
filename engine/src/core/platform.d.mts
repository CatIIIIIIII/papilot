import type { ChildProcess } from 'node:child_process';
export function envPath(env?: NodeJS.ProcessEnv): string;
export function findCommand(command: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string | null;
export function commandSpec(command: string, args: string[], env?: NodeJS.ProcessEnv): { command: string; args: string[] };
export function npmCli(env?: NodeJS.ProcessEnv, executable?: string): string;
export function terminateTree(child: ChildProcess, signal?: NodeJS.Signals): void;
