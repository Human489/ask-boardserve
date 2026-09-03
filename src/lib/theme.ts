// Theme choice: what the reader picked, and what that resolves to.
//
// Three states rather than two. A boolean toggle cannot say "follow the
// machine", and that is the right default for a tool someone opens between
// other work — it should already match the desk it landed on.
//
// The light palette was written first and is the one BoardServe leads with,
// but until this existed it was unreachable: the stylesheet keyed off
// prefers-color-scheme alone, so a reader whose OS is dark could never see
// light, and had no idea a light theme existed at all.
//
// Kept pure and free of React so the resolution rules can be tested without a
// renderer, the same reason swapTranscript lives outside Chat.tsx.

export const THEME_CHOICES = ['system', 'light', 'dark'] as const
export type ThemeChoice = (typeof THEME_CHOICES)[number]

/** What actually gets painted, once "system" has been resolved. */
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'bs_theme'

/** Human labels, so the control and the announcement cannot disagree. */
export const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value)
}

/**
 * The stored choice, or 'system' when there is nothing usable.
 *
 * Anything unrecognised reads as 'system' rather than throwing: the value is
 * in localStorage, which a reader can edit, another tab can overwrite, and a
 * future version of this app might write a name this one has never heard of.
 */
export function readChoice(raw: string | null | undefined): ThemeChoice {
  return isThemeChoice(raw) ? raw : 'system'
}

/**
 * What to paint, given the choice and what the machine prefers.
 *
 * `prefersDark` is passed in rather than read here, so this stays pure and the
 * caller owns the media query.
 */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'light') return 'light'
  if (choice === 'dark') return 'dark'
  return prefersDark ? 'dark' : 'light'
}

/**
 * The value for the root element's data-theme attribute.
 *
 * 'system' deliberately stamps NOTHING. The stylesheet's default is light and
 * its media query supplies dark, so an absent attribute is what lets the OS
 * decide — and it means a reader who never touches the control gets exactly
 * the behaviour the app had before this existed.
 */
export function rootAttribute(choice: ThemeChoice): ResolvedTheme | null {
  return choice === 'system' ? null : choice
}

/**
 * Applies a choice to a root element.
 *
 * Also sets the theme-color meta, which paints the browser's own chrome on
 * mobile. Without it a reader who picks Light on a dark phone gets a light
 * page under a black address bar.
 */
export function applyTheme(
  root: HTMLElement,
  choice: ThemeChoice,
  prefersDark: boolean,
  themeColors: Record<ResolvedTheme, string>,
): ResolvedTheme {
  const attribute = rootAttribute(choice)
  if (attribute === null) root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', attribute)

  const resolved = resolveTheme(choice, prefersDark)
  // All of them, not the first. Next can emit a competing theme-color meta,
  // and "the first one" is not a promise about which the browser reads.
  for (const meta of root.ownerDocument.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute('content', themeColors[resolved])
  }
  return resolved
}

/** The two ground colours, kept beside the tokens they mirror in globals.css. */
export const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#faf8f6',
  dark: '#0f0d0c',
}
