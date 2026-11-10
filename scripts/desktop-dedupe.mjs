import fs from 'node:fs';
import path from 'node:path';

// The review engine sits inside the server folder, so Node resolves a package
// it lacks from the server's node_modules (also through a layer's links, see
// linkBundle). Its own copies of the same packages (mupdf, esbuild, fastify,
// React…) only made the installer larger.
export function dedupeEngine(server) {
  const outer = path.join(server, 'node_modules'), inner = path.join(server, 'engine/node_modules');
  const packages = folder => { try { return JSON.parse(fs.readFileSync(path.join(folder, 'package-lock.json'), 'utf8')).packages || {}; } catch { return {}; } };
  const serverLock = packages(server), engineLock = packages(path.join(server, 'engine'));
  const version = folder => { try { return JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).version || null; } catch { return null; } };
  const names = fs.readdirSync(inner).filter(name => !name.startsWith('.'))
    .flatMap(name => name.startsWith('@') ? fs.readdirSync(path.join(inner, name)).map(child => `${name}/${child}`) : [name]);
  let bytes = 0;
  const size = file => { const stat = fs.lstatSync(file); return stat.isDirectory() ? fs.readdirSync(file).reduce((sum, name) => sum + size(path.join(file, name)), 0) : stat.size; };
  for (const name of names) {
    const shared = serverLock[`node_modules/${name}`], local = engineLock[`node_modules/${name}`];
    // A version alone cannot distinguish packages from different registries or builds.
    if (!shared || !local || !local.version || local.version !== shared.version) continue;
    const identity = local.integrity || local.resolved;
    if (!identity || identity !== (shared.integrity || shared.resolved)) continue;
    // Removing a package also moves where Node resolves its dependencies.
    const dependencies = Object.keys({ ...local.dependencies, ...local.optionalDependencies, ...local.peerDependencies });
    if (dependencies.some(dependency => {
      const top = `node_modules/${dependency}`, nested = `node_modules/${name}/node_modules/${dependency}`;
      return !engineLock[top]?.version || engineLock[top].version !== serverLock[top]?.version || engineLock[nested] || serverLock[nested];
    })) continue;
    const own = version(path.join(inner, name));
    if (!own || own !== version(path.join(outer, name))) continue;
    bytes += size(path.join(inner, name));
    fs.rmSync(path.join(inner, name), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(inner)) if (name.startsWith('@') && !fs.readdirSync(path.join(inner, name)).length) fs.rmdirSync(path.join(inner, name));
  // Executables of removed packages: links on macOS and Linux, shims on Windows.
  const bin = path.join(inner, '.bin');
  if (fs.existsSync(bin)) for (const name of fs.readdirSync(bin)) {
    const file = path.join(bin, name), stat = fs.lstatSync(file);
    if (!stat.isFile() && !stat.isSymbolicLink()) continue;
    const targets = stat.isSymbolicLink() ? [path.resolve(bin, fs.readlinkSync(file))]
      : [...fs.readFileSync(file, 'utf8').matchAll(/\.\.[\\/]((?:@[^\\/"']+[\\/])?[^\\/"']+)[\\/]/g)].map(match => path.join(inner, ...match[1].split(/[\\/]/)));
    if (targets.some(target => !fs.existsSync(target))) fs.rmSync(file, { force: true });
  }
  return bytes;
}
