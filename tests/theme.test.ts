import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  THEME_CHOICES,
  THEME_COLORS,
  isThemeChoice,
  readChoice,
  resolveTheme,
  rootAttribute,
} from '../src/lib/theme'

// The light palette shipped from the first commit and nobody could reach it.
// The stylesheet keyed off prefers-color-scheme alone, so a reader whose
// machine is dark saw dark for ever and had no way to learn a light theme
// existed. Reported by the user, who assumed the app was dark-only.
//
// Two things are pinned here: the resolution rules, and the fact that the dark
// tokens — which CSS forces us to declare twice — stay identical.

test('an explicit choice beats the machine, in both directions', () => {
  assert.equal(resolveTheme('light', true), 'light', 'Light on a dark machine')
  assert.equal(resolveTheme('dark', false), 'dark', 'Dark on a light machine')
})

test('system follows the machine', () => {
  assert.equal(resolveTheme('system', true), 'dark')
  assert.equal(resolveTheme('system', false), 'light')
})

test('system stamps no attribute, which is what lets the OS decide', () => {
  // The stylesheet defaults to light and its media query supplies dark, so an
  // absent attribute is the mechanism, not an oversight. Stamping "system"
  // would match neither selector and pin every reader to light.
  assert.equal(rootAttribute('system'), null)
  assert.equal(rootAttribute('light'), 'light')
  assert.equal(rootAttribute('dark'), 'dark')
})

test('a stored value that is not a theme reads as system', () => {
  // localStorage is reader-editable, another tab can overwrite it, and a later
  // version of this app might write a name this one has never heard of.
  for (const junk of [null, undefined, '', 'System', 'DARK', 'sepia', '{}', '0']) {
    assert.equal(readChoice(junk), 'system', `${String(junk)} should fall back`)
  }
  for (const valid of THEME_CHOICES) {
    assert.equal(readChoice(valid), valid)
  }
  assert.ok(!isThemeChoice(42))
  assert.ok(!isThemeChoice(null))
})

test('every choice has a theme colour to paint the browser chrome with', () => {
  for (const choice of THEME_CHOICES) {
    for (const prefersDark of [true, false]) {
      const resolved = resolveTheme(choice, prefersDark)
      assert.ok(THEME_COLORS[resolved], `${choice}/${String(prefersDark)} has no colour`)
      assert.match(THEME_COLORS[resolved], /^#[0-9a-f]{6}$/)
    }
  }
})

// --------------------------------------------------------------------------

function darkBlocks(): [string, string] {
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
  const begin = css.indexOf('/* dark:begin */')
  const end = css.indexOf('/* dark:end */')
  assert.ok(begin > -1 && end > begin, 'the dark:begin/dark:end markers must exist')
  const region = css.slice(begin, end)

  // The media-query copy, then the attribute copy.
  const mediaAt = region.indexOf("(prefers-color-scheme: dark)")
  const attrAt = region.indexOf("data-theme='dark'", mediaAt)
  assert.ok(mediaAt > -1, 'the media-query copy must exist')
  assert.ok(attrAt > -1, 'the [data-theme=dark] copy must exist')
  return [region.slice(mediaAt, attrAt), region.slice(attrAt)]
}

/** Every custom property a block declares, as name -> value. */
function tokensIn(block: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of block.split('\n')) {
    const match = /^\s*(--[a-z0-9-]+):\s*(.+?);\s*$/i.exec(line)
    if (match) out.set(match[1], match[2].trim())
  }
  return out
}

test('the two dark token blocks are identical', () => {
  // CSS cannot share one declaration block between a media query and an
  // attribute selector, and light-dark() is too new to rely on for something
  // opened live in a meeting. So the dark tokens are written twice:
  //
  //   - in the media query, for readers on System with a dark machine
  //   - on [data-theme='dark'], for readers who chose Dark on a light machine
  //
  // Two copies can drift, and a drifted copy means one of those two readers
  // silently loses a contrast fix that the other one got. This is the check
  // that stops it, because nothing about the drift would be visible to
  // whoever edited only the first block.
  const [media, attribute] = darkBlocks()
  const a = tokensIn(media)
  const b = tokensIn(attribute)

  assert.ok(a.size > 20, `expected the full dark palette, found ${a.size}`)
  assert.deepEqual(
    [...a.keys()].sort(),
    [...b.keys()].sort(),
    'the two dark blocks declare different tokens',
  )
  for (const [name, value] of a) {
    assert.equal(b.get(name), value, `${name} differs between the two dark blocks`)
  }
})

test('the light palette is the default, declared on bare :root', () => {
  // If the light values only existed inside a media query, an explicit Light
  // choice on a dark machine would have nothing to apply.
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
  const rootAt = css.indexOf(':root {')
  const firstMedia = css.indexOf('@media')
  assert.ok(rootAt > -1 && rootAt < firstMedia, ':root must come before any media query')

  const block = css.slice(rootAt, css.indexOf('}', rootAt))
  const light = tokensIn(block)
  const [media] = darkBlocks()
  for (const name of tokensIn(media).keys()) {
    assert.ok(light.has(name), `${name} has no light value on bare :root`)
  }
})

test('the theme colours match the palette tokens they mirror', () => {
  // These live in TypeScript because the inline script needs them before any
  // stylesheet has parsed, so they can fall out of step with the CSS.
  const css = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
  const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('@media'))
  const lightPlane = tokensIn(rootBlock).get('--plane')
  const [media] = darkBlocks()
  const darkPlane = tokensIn(media).get('--plane')

  assert.equal(THEME_COLORS.light, lightPlane, 'light theme-color is not --plane')
  assert.equal(THEME_COLORS.dark, darkPlane, 'dark theme-color is not --plane')
})

test('the chart palette re-reads on a data-theme change, not just a media change', () => {
  // BoardChart reads its colours from the CSS custom properties at runtime, so
  // one declaration serves both themes. It listened only to
  // prefers-color-scheme, which was sufficient while the OS was the only input.
  //
  // Adding the System/Light/Dark control broke that silently. Switching to
  // Light on a dark machine changes an attribute and fires no media event, so
  // the chart kept the palette it read on mount: measured live, the tokens said
  // --series-1: #256cc4 while the bars were still filled #5f9ee8 — the dark
  // blue — on a white card. Not merely stale, but a contrast failure, since
  // #5f9ee8 on white is about 2.6:1 against the 3:1 a chart mark must hold.
  //
  // Asserted on the source because the fix is an effect: this suite renders
  // components with renderToStaticMarkup, which never runs one.
  const source = readFileSync(join(process.cwd(), 'src/components/BoardChart.tsx'), 'utf8')

  assert.match(source, /MutationObserver/, 'the palette must observe attribute changes')
  assert.match(
    source,
    /attributeFilter:\s*\[\s*'data-theme'\s*\]/,
    'the observer must watch data-theme specifically, not every attribute',
  )
  assert.match(source, /prefers-color-scheme: dark/, 'and must still follow the OS')
  assert.match(source, /observer\.disconnect\(\)/, 'and must disconnect on unmount')
})
