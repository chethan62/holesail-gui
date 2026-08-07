/* scripts/gen-icon.mjs — generates a 1024x1024 source PNG for `tauri icon`.
   Pure Node (zlib + manual PNG chunks), no image deps. Draws a simple
   "sail" motif: dark navy background, blue sail triangle, yellow sun. */

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const SIZE = 1024
const bg = [15, 20, 32] // #0f1420
const sail = [59, 130, 246] // #3b82f6
const sun = [234, 179, 8] // #eab308

// right triangle: (256,768) -> (256,256) -> (768,512)
function inSail(x, y) {
  return x >= 256 && x <= 768 && y >= 256 && y <= 768 && y >= 512 - (x - 256) * 0.5
}
function inSun(x, y) {
  const dx = x - 700
  const dy = y - 260
  return dx * dx + dy * dy <= 90 * 90
}

const rows = []
for (let y = 0; y < SIZE; y++) {
  const row = Buffer.alloc(1 + SIZE * 3)
  row[0] = 0 // filter: none
  for (let x = 0; x < SIZE; x++) {
    let [r, g, b] = bg
    if (inSail(x, y)) [r, g, b] = sail
    if (inSun(x, y)) [r, g, b] = sun
    row[1 + x * 3] = r
    row[2 + x * 3] = g
    row[3 + x * 3] = b
  }
  rows.push(row)
}

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 2 // color type: RGB
const raw = Buffer.concat(rows)
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons')
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, 'source.png'), png)
console.log('wrote', path.join(outDir, 'source.png'), png.length, 'bytes')
