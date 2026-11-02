export const LAYER_FORMAT: number;
export const MANIFEST: string;
export function shellFingerprint(root?: string, node?: string): string;
export function desktopVersion(version: string, revision?: string): string;
export function layerName(version: string): string;
export function buildLayer(root?: string, output?: string, revision?: string): { format: number; version: string; fingerprint: string; layer: { name: string; size: number; sha256: string } };
export const INSTALLER_SUFFIXES: string[];
export function reusableInstallers(previous: any, assets: string[], fingerprint: string): string[] | null;
