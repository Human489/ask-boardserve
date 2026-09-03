# Fonts

Self-hosted rather than loaded from Google's CDN. Two reasons, both about the
use scene: the app is opened live in a board meeting, where a third-party
request is a dependency nobody chose, and board data is sensitive enough that
a font request leaking the referrer is worth avoiding.

Latin subsets only (`U+0000-00FF` and friends). The full families carry
Cyrillic, Greek and Vietnamese ranges this product has no use for.

| File | Family | Licence |
|---|---|---|
| `instrument-serif-400.woff2` | Instrument Serif, 400 | SIL Open Font License 1.1 |
| `geist-mono.woff2` | Geist Mono, variable 100–900 | SIL Open Font License 1.1 |

`geist-mono.woff2` is a single variable file. It was downloaded twice, once per
weight, and the two files were byte-identical — so it ships once and the
`@font-face` declares `font-weight: 100 900`.

Both are declared `font-display: swap` with a real fallback stack, so text is
readable before they arrive and still readable if they never do.
