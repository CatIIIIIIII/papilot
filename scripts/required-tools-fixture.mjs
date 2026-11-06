// Unrelated browser scenarios assume a working host. Missing and partial
// installations are exercised in check-system-requirements.mjs.
export const readyRequirements = { platform: 'linux', checks: ['git', 'latexmk', 'synctex', 'tex-engine'].map(id => ({ id, ok: true })) };
