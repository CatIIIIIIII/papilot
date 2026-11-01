module.exports = {
  appId: 'ai.papilot.desktop',
  productName: 'Papilot',
  directories: { app: '.desktop/app', output: 'release/desktop', buildResources: 'desktop/assets' },
  files: ['*.js', '*.cjs', 'package.json', '!node_modules{,/**/*}'],
  extraResources: [
    { from: '.desktop/server', to: 'server' },
    // electron-builder's generic file copier skips root node_modules.
    { from: '.desktop/server/node_modules', to: 'server/node_modules' },
    { from: '.desktop/runtime', to: 'runtime' },
    { from: 'desktop/assets/icon.png', to: 'desktop/assets/icon.png' },
  ],
  asar: true,
  npmRebuild: false,
  artifactName: 'Papilot-${version}-${os}-${arch}.${ext}',
  mac: { category: 'public.app-category.productivity', icon: 'desktop/assets/icon.icns', target: ['dmg', 'zip'],
    // Local builds are ad hoc signed. Only opt into a certificate explicitly.
    identity: process.env.CSC_NAME || (process.env.CSC_LINK ? undefined : '-'),
  },
  dmg: {
    title: 'Papilot ${version}', background: 'desktop/assets/dmg-background.png',
    iconSize: 80, iconTextSize: 13,
    contents: [{ x: 180, y: 218, type: 'file' }, { x: 460, y: 218, type: 'link', path: '/Applications' }],
  },
  linux: { target: ['AppImage', 'deb'], executableName: 'papilot', category: 'Office',
    icon: 'desktop/assets/icon.png', maintainer: 'Cui Chen <i@cuichen.cc>', syncDesktopName: true,
    synopsis: 'A workspace for your papers',
  },
  deb: { depends: ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0', 'libuuid1', 'libsecret-1-0', 'libasound2', 'libgbm1', 'git'] },
};
