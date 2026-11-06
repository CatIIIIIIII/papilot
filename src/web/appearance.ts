export type ColorMode = 'light' | 'dark';
export type PresetId = 'papilot' | 'paper' | 'slate';
export type AccentId = 'default' | 'blue' | 'graphite' | 'stone';
type Colors = { background?: string; foreground?: string };
export type Appearance = { preset: PresetId; accent: AccentId; colors: Record<ColorMode, Colors>; pdf: 'theme' | 'light'; review: 'pdf' | 'theme' | 'light' };
export const APPEARANCE_KEY = 'papilot:appearance';
export const DEFAULT_APPEARANCE: Appearance = { preset: 'papilot', accent: 'default', colors: { light: {}, dark: {} }, pdf: 'theme', review: 'pdf' };
// Paper stays the visual focus. Presets vary the warmth of neutral surfaces;
// accents are reserved for actions, selection and focus, with no decorative tint.
export const PRESETS = {
  papilot: { light: { background: '#ffffff', foreground: '#171717', accent: '#2563eb' }, dark: { background: '#26272b', foreground: '#ececee', accent: '#2563eb' } },
  paper: { light: { background: '#faf9f6', foreground: '#302e2b', accent: '#74695c' }, dark: { background: '#282724', foreground: '#e8e6e1', accent: '#74695c' } },
  slate: { light: { background: '#f6f7f8', foreground: '#2c3035', accent: '#526477' }, dark: { background: '#24272b', foreground: '#e5e7ea', accent: '#526477' } },
} satisfies Record<PresetId, Record<ColorMode, { background: string; foreground: string; accent: string }>>;
export const ACCENTS = { blue: '#526477', graphite: '#55565a', stone: '#74695c' };

export function hexColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const hex = value.trim().replace(/^#/, '');
  if (/^[\da-f]{6}$/i.test(hex)) return '#' + hex.toLowerCase();
  if (/^[\da-f]{3}$/i.test(hex)) return '#' + [...hex].map(char => char + char).join('').toLowerCase();
}

// Stored preferences are untrusted: old or malformed values fall back field by field.
export function parseAppearance(value: string | null): Appearance {
  try {
    const saved = JSON.parse(value || '{}');
    const colors = (mode: ColorMode): Colors => ({ background: hexColor(saved?.colors?.[mode]?.background), foreground: hexColor(saved?.colors?.[mode]?.foreground) });
    return {
      preset: typeof saved?.preset === 'string' && Object.hasOwn(PRESETS, saved.preset) ? saved.preset : 'papilot',
      accent: typeof saved?.accent === 'string' && (saved.accent === 'default' || Object.hasOwn(ACCENTS, saved.accent)) ? saved.accent : 'default',
      colors: { light: colors('light'), dark: colors('dark') },
      pdf: saved?.pdf === 'light' ? 'light' : 'theme',
      review: saved?.review === 'theme' || saved?.review === 'light' ? saved.review : 'pdf',
    };
  } catch { return DEFAULT_APPEARANCE; }
}

function mix(base: string, color: string, amount: number) {
  const channels = [1, 3, 5].map(index => Math.round(parseInt(base.slice(index, index + 2), 16) * (1 - amount) + parseInt(color.slice(index, index + 2), 16) * amount));
  return '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('');
}

export function appearanceColors(appearance: Appearance, mode: ColorMode) {
  const preset = PRESETS[appearance.preset][mode];
  return { background: appearance.colors[mode].background || preset.background, foreground: appearance.colors[mode].foreground || preset.foreground, accent: appearance.accent === 'default' ? preset.accent : ACCENTS[appearance.accent] };
}

export function appearanceVariables(appearance: Appearance, mode: ColorMode): Record<string, string> {
  const { background: bg, foreground: fg, accent } = appearanceColors(appearance, mode);
  const dark = mode === 'dark';
  const darkPaper = dark && appearance.pdf === 'theme';
  const darkReview = appearance.review === 'pdf' ? darkPaper : dark && appearance.review === 'theme';
  const custom = appearance.preset !== 'papilot' || appearance.colors[mode].background || appearance.colors[mode].foreground;
  const customAccent = appearance.preset !== 'papilot' || appearance.accent !== 'default';
  const defaults = dark
    ? { '--sidebar': '#202124', '--bg-subtle': '#2a2b2f', '--bg-muted': '#303135', '--bg-hover': '#37383c', '--bg-active': '#404145', '--canvas': '#1e1f22', '--line': '#38393e', '--line-strong': '#4b4c52', '--line-hover': '#63646b', '--text-2': '#c2c3c9', '--text-3': '#9c9da5' }
    : { '--sidebar': '#f9f9f9', '--bg-subtle': '#fafafa', '--bg-muted': '#f4f4f4', '--bg-hover': '#efefef', '--bg-active': '#e7e7e7', '--canvas': '#f3f3f3', '--line': '#e8e8e8', '--line-strong': '#d6d6d6', '--line-hover': '#c4c4c4', '--text-2': '#525252', '--text-3': '#8a8a8a' };
  const activeAccent = customAccent ? (dark ? mix(accent, '#ffffff', .45) : accent) : (dark ? '#8ab4ff' : '#2563eb');
  return {
    '--bg': bg, '--text': fg,
    ...(custom ? {
      '--sidebar': mix(bg, dark ? '#000000' : fg, dark ? .16 : .025), '--bg-subtle': mix(bg, fg, .025), '--bg-muted': mix(bg, fg, .055),
      '--bg-hover': mix(bg, fg, .09), '--bg-active': mix(bg, fg, .14), '--canvas': mix(bg, dark ? '#000000' : fg, dark ? .24 : .05),
      '--line': mix(bg, fg, .12), '--line-strong': mix(bg, fg, .22), '--line-hover': mix(bg, fg, .32), '--text-2': mix(bg, fg, .76), '--text-3': mix(bg, fg, .58),
    } : defaults),
    '--accent': activeAccent, '--accent-hover': customAccent ? mix(activeAccent, dark ? '#ffffff' : '#000000', .18) : (dark ? '#b2ceff' : '#1d4ed8'),
    '--accent-soft': !custom && !customAccent ? (dark ? '#2b3651' : '#eff6ff') : mix(bg, activeAccent, .11),
    '--accent-line': !custom && !customAccent ? (dark ? '#445c85' : '#bfdbfe') : mix(bg, activeAccent, .3),
    '--primary': accent, '--primary-hover': customAccent ? mix(accent, '#000000', .18) : '#1d4ed8',
    '--ring': `0 0 0 3px ${activeAccent}33`,
    '--pdf-filter': darkPaper ? 'invert(.84) hue-rotate(180deg)' : 'none',
    '--pdf-page': darkPaper ? '#292929' : '#ffffff',
    '--review-theme': darkReview ? 'dark' : 'light',
    '--review-filter': darkReview ? 'invert(.84) hue-rotate(180deg)' : 'none',
    '--review-page': darkReview ? '#292929' : '#ffffff',
    '--review-before': darkReview ? '#432c30' : '#fbeeee',
    '--review-after': darkReview ? '#28392d' : '#eef8f1',
  };
}

const properties = Object.keys(appearanceVariables(DEFAULT_APPEARANCE, 'light'));
export function syncAppearance(source: HTMLElement, target: HTMLElement) {
  target.dataset.theme = source.dataset.theme;
  target.dataset.reviewTheme = source.style.getPropertyValue('--review-theme') || source.dataset.theme || 'light';
  for (const property of properties) {
    const value = source.style.getPropertyValue(property);
    if (value) target.style.setProperty(property, value); else target.style.removeProperty(property);
  }
}
