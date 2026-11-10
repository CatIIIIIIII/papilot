export function isWsl(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, release?: string): boolean;
export function windowsDrive(dir: string): boolean;
export function codexCandidates(env: NodeJS.ProcessEnv, data: string, root: string, wsl?: boolean): string[];
export function firstRunnable(candidates: string[], env?: NodeJS.ProcessEnv, options?: { timeout?: number; budget?: number; signal?: AbortSignal }): Promise<string | null>;
