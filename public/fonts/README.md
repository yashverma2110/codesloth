# Bundled fonts

All are licensed under the SIL Open Font License 1.1 (see each folder's `OFL.txt`). WOFF2 only. JetBrains Mono, Fira Code and Iosevka: weights 400 and 600, Latin subset. OpenDyslexic: complete, not subset (see below).

| Font | Source | Notes |
| --- | --- | --- |
| JetBrains Mono | `@fontsource/jetbrains-mono` 5.3.0, `latin-400/600-normal.woff2` | unmodified |
| Fira Code | `@fontsource/fira-code` 5.3.0, `latin-400/600-normal.woff2` | unmodified |
| Iosevka | `@fontsource/iosevka` 5.3.0, `latin-400/600-normal.woff2` | subset with fonttools `pyftsubset` to Basic Latin, Latin-1, general punctuation, arrows, ✓ and ⚠ (features: calt, ccmp, locl, kern, mark, mkmk), because the upstream "latin" file is ~1 MB |
| OpenDyslexic (proportional) | author's release [v0.91.12](https://github.com/antijingoist/opendyslexic/releases/tag/v0.91.12), `OpenDyslexic-Regular.woff2` / `OpenDyslexic-Bold.woff2` → `opendyslexic-400/700.woff2` | unmodified; used for "Use for all panel text" |
| OpenDyslexic Mono | built from upstream source `sources/opendyslexic-mono/OpenDyslexic-Mono.glyphs` (commit e7ac50a) with fontmake 3.12, `-o otf --feature-writer KernFeatureWriter` (the source's mark anchors don't compile), then lossless WOFF2 compression with fonttools | Regular only; not subset, because OpenDyslexic is a Reserved Font Name and an OFL subset would be a Modified Version that couldn't keep the name |

Fonts are loaded only from the extension package (`chrome.runtime.getURL`), never from the network.
