# renderer/vendor

Hand-vendored browser JavaScript. Nothing here is an npm dependency, so the
payload walk in `scripts/licence-check.py` cannot see it — **the file hash is
the pin**, and `scripts/licence-check.py --vendored` enforces it.

| File | Upstream | Version | Licence | sha256 |
|---|---|---|---|---|
| `qrcode.js` | [kazuhikoarase/qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) — the single-file `js/qrcode.js` build | unversioned single-file build; **the hash below is the pin** | MIT (© 2009 Kazuhiko Arase, header in the file) | `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780` |

Size at the recorded hash: 56,694 bytes.

## Re-verifying

```bash
sha256sum renderer/vendor/qrcode.js          # must equal the table above
python3 scripts/licence-check.py --vendored  # the same check, with a negative control
```

## Updating the vendored file

1. Replace the file.
2. `sha256sum renderer/vendor/qrcode.js` and put the new value in **both** this
   table and `VENDORED` in `scripts/licence-check.py` — one without the other
   fails the check, which is the point.
3. Confirm the new file still carries its upstream licence header.
4. Load the app and generate a QR (the renderer test stub has no real DOM, so
   nothing automated covers QR drawing).
