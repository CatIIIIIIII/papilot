"""Build a local Apple Silicon preview from an extracted official 0.8.9 app.

First build the frontend, review frontend and desktop TypeScript. This script
preserves the official runtime/dependencies and overlays the custom source.
"""
from pathlib import Path
import argparse
import json
import plistlib
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--base-app', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
source = Path(__file__).resolve().parents[1]
version = json.loads((source / 'package.json').read_text())['version']
base_info = plistlib.loads((args.base_app / 'Contents/Info.plist').read_bytes())
if base_info['CFBundleShortVersionString'] != '0.8.9':
    raise SystemExit('Use the official 0.8.9 app as the base.')
app = args.output / 'Papilot Preview.app'
if app.exists():
    raise SystemExit('Output already exists; choose an empty output directory.')
args.output.mkdir(parents=True, exist_ok=True)
subprocess.run(['ditto', str(args.base_app), str(app)], check=True)
resources = app / 'Contents/Resources'
server = resources / 'server'
for name in ['src', 'dist', 'bin', 'skills', 'engine/src', 'engine/dist']:
    incoming = source / name
    if not incoming.is_dir():
        raise SystemExit(f'Missing build input: {incoming}')
    dest = server / name
    shutil.rmtree(dest, ignore_errors=True)
    shutil.copytree(incoming, dest)
pkg = json.loads((source / 'package.json').read_text())
pkg['dependencies']['@openai/codex'] = pkg['devDependencies']['@openai/codex']
(server / 'package.json').write_text(json.dumps(pkg, indent=2) + '\n')
shutil.copyfile(source / 'engine/package.json', server / 'engine/package.json')
(resources / 'app.asar').unlink(missing_ok=True)
main = resources / 'app'
shutil.rmtree(main, ignore_errors=True)
shutil.copytree(source / '.desktop/app', main)
# Keep the preview on its bundled code, independent of official update layers.
(main / 'package.json').write_text(json.dumps({
    'name': 'papilot-preview', 'productName': 'Papilot Preview',
    'version': version, 'type': 'module', 'main': 'main.js',
}, indent=2) + '\n')
p = app / 'Contents/Info.plist'
info = plistlib.loads(p.read_bytes())
info.update(CFBundleDisplayName='Papilot Preview', CFBundleName='Papilot',
            CFBundleIdentifier='ai.papilot.desktop.preview',
            CFBundleShortVersionString='0.8.9', CFBundleVersion='0.8.9.10')
info.pop('ElectronAsarIntegrity', None)
p.write_bytes(plistlib.dumps(info))
(resources / 'app-update.yml').unlink(missing_ok=True)
subprocess.run(['codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
(args.output / 'Applications').symlink_to('/Applications', target_is_directory=True)
(args.output / '说明.txt').write_text(
    f'Papilot Preview {version}（Apple Silicon）\n\n'
    '基于官方 0.8.9 及 2026-11-05 主分支，包含个人问答、PDF 左右对照和紧凑滑块。\n'
    '将 Papilot Preview.app 拖入 Applications；退出旧预览版后替换。\n'
    '沿用 ~/Library/Application Support/Papilot Preview 数据目录。\n'
    '本地临时签名，关闭官方自动更新；源代码见 CatIIIIIIII/papilot 的 custom/ning-preview 分支。\n')
for name in ['src', 'dist', 'engine/src', 'engine/dist']:
    for p in (source / name).rglob('*'):
        if p.is_file():
            assert p.read_bytes() == (server / p.relative_to(source)).read_bytes(), str(p)
print(app)
