import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Ask BoardServe',
  description:
    'Ask questions of your board attendance, actions and skills data in plain English.',
}

export const viewport: Viewport = {
  // themeColor is deliberately NOT set here.
  //
  // Next emits its own <meta name="theme-color"> from this export and
  // re-renders it during hydration, so the one the theme script had just
  // corrected went back to the light value and the page ended up with two
  // metas disagreeing. The meta is rendered in <head> below instead, where
  // exactly one exists and both the inline script and applyTheme own it.
  //
  // The two-entry media form cannot serve this either: it cannot express an
  // explicit choice, so a reader picking Light on a dark phone would get a
  // light page under a black address bar.
  colorScheme: 'light dark',
}

/**
 * Stamps the stored theme on <html> before the first paint.
 *
 * This has to be a blocking inline script. Applying the theme in an effect
 * means React runs after the browser has already painted, so a reader who
 * chose Light on a dark machine sees a dark flash on every load — worse on the
 * passcode screen, which is the first thing anyone sees.
 *
 * 'system' stamps nothing: the stylesheet defaults to light and its media
 * query supplies dark, so an absent attribute is what lets the OS decide.
 *
 * Wrapped in try/catch because localStorage throws rather than returning null
 * in a private window or with site data blocked, and an exception here would
 * leave the document without its theme.
 */
const THEME_SCRIPT = `(function(){try{
var c=localStorage.getItem('bs_theme');
if(c==='light'||c==='dark'){document.documentElement.setAttribute('data-theme',c);}
var d=c==='dark'||(c!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches);
var m=document.querySelectorAll('meta[name="theme-color"]');
for(var i=0;i<m.length;i++){m[i].setAttribute('content',d?'#0f0d0c':'#faf8f6');}
}catch(e){}})();`

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning is load-bearing, not cosmetic. The inline script
    // below stamps data-theme before paint; the server markup does not have it,
    // so React reconciled <html> during hydration and REMOVED the attribute.
    // Measured: the script ran and set theme-color correctly, then data-theme
    // was gone by the time hydration finished, leaving a reader who chose Dark
    // on a light machine with a light page and a control saying Dark.
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        {/* Light is the default, and the script below corrects it before paint
            when the reader has chosen otherwise. */}
        <meta name="theme-color" content="#faf8f6" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  )
}
