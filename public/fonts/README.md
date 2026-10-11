# Bundled fonts

All three are licensed under the SIL Open Font License 1.1 (see each folder's `OFL.txt`). Only WOFF2, weights 400 and 600, Latin subset.

| Font | Source | Notes |
| --- | --- | --- |
| JetBrains Mono | `@fontsource/jetbrains-mono` 5.3.0, `latin-400/600-normal.woff2` | unmodified |
| Fira Code | `@fontsource/fira-code` 5.3.0, `latin-400/600-normal.woff2` | unmodified |
| Iosevka | `@fontsource/iosevka` 5.3.0, `latin-400/600-normal.woff2` | subset with fonttools `pyftsubset` to Basic Latin, Latin-1, general punctuation, arrows, ✓ and ⚠ (features: calt, ccmp, locl, kern, mark, mkmk), because the upstream "latin" file is ~1 MB |

Fonts are loaded only from the extension package (`chrome.runtime.getURL`), never from the network.
