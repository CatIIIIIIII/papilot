import { version } from '../../../package.json';
import { ActionMenu } from '../action-menu.tsx';
import { Icon } from '../icons.tsx';

// The same versioned installer names used by the website's download menu.
const installer = (suffix: string) => `https://github.com/PapilotAI/papilot/releases/download/v${version}/Papilot-${version}-${suffix}`;

function PlatformIcon({ platform }: { platform: string }) {
  if (platform === 'Linux') return <i className="demo-linux-icon" aria-hidden="true"/>;
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d={platform === 'Windows' ? 'M3 4h8v7H3zM13 4h8v7h-8zM3 13h8v7H3zM13 13h8v7h-8z' : 'M16.37 12.6c-.02-2.33 1.9-3.45 1.99-3.5-1.08-1.59-2.77-1.8-3.37-1.83-1.43-.15-2.8.84-3.53.84-.73 0-1.85-.82-3.04-.8-1.56.02-3 .91-3.81 2.31-1.62 2.82-.42 6.99 1.17 9.27.77 1.12 1.7 2.38 2.91 2.33 1.17-.05 1.61-.75 3.02-.75 1.41 0 1.81.75 3.04.73 1.26-.02 2.05-1.14 2.82-2.26.89-1.3 1.25-2.55 1.27-2.62-.03-.01-2.44-.94-2.47-3.72ZM14.05 5.75c.64-.78 1.08-1.86.96-2.94-.93.04-2.05.62-2.71 1.4-.6.69-1.12 1.79-.98 2.85 1.03.08 2.09-.53 2.73-1.31Z'}/>
  </svg>;
}

export function DemoDownloads({ zh }: { zh: boolean }) {
  const platforms = [
    { name: 'macOS', downloads: [
      { label: zh ? 'Apple 芯片' : 'Apple Silicon', hint: '.dmg', href: installer('mac-arm64.dmg') },
      { label: zh ? 'Intel 芯片' : 'Intel', hint: '.dmg', href: installer('mac-x64.dmg') },
    ] },
    { name: 'Windows', downloads: [
      { label: zh ? '安装版' : 'Installer', hint: 'x64 · .exe', href: installer('win-x64.exe') },
      { label: zh ? '便携版' : 'Portable app', hint: 'x64 · .exe', href: installer('win-x64-portable.exe') },
    ] },
    { name: 'Linux', downloads: [
      { label: 'AppImage', hint: 'x64', href: installer('linux-x86_64.AppImage') },
      { label: 'Debian / Ubuntu', hint: 'x64 · .deb', href: installer('linux-amd64.deb') },
    ] },
  ];
  return <div className="demo-downloads" role="group" aria-label={zh ? '下载 Papilot' : 'Download Papilot'}>
    {platforms.map(platform => <ActionMenu key={platform.name} label={zh ? `下载 ${platform.name} 版` : `Download for ${platform.name}`} actions={platform.downloads} className="button secondary compact demo-platform" align="end">
      <PlatformIcon platform={platform.name}/><span>{platform.name}</span><Icon name="chevronDown" size={12}/>
    </ActionMenu>)}
  </div>;
}
