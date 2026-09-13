// 生成应用图标源图（1024×1024 PNG），纯 Node 实现，不引入图像依赖。
//
// 用法：node scripts/make-icon.mjs
// 产物：apps/desktop/app-icon.png —— 再交给 `pnpm icon`（tauri icon）生成各平台尺寸。

import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const RADIUS = 200

const BG = [20, 22, 26, 255]
const PANEL = [32, 36, 44, 255]
const ACCENT = [122, 162, 247, 255]
const ACCENT_SOFT = [86, 122, 196, 255]

/** CRC32（PNG 分块校验）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([length, typeBuf, data, crc])
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const stride = width * 4
  const rawWithFilters = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    rawWithFilters[y * (stride + 1)] = 0 // filter: none
    rgba.copy(rawWithFilters, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rawWithFilters, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 圆角矩形内部判定。 */
function inRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x >= size || y >= size) return false
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

/** 点到线段的距离。 */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = px - ax
  const wy = py - ay
  const len = vx * vx + vy * vy
  const t = len === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len))
  const dx = px - (ax + t * vx)
  const dy = py - (ay + t * vy)
  return Math.hypot(dx, dy)
}

// 字母 M 的折线（笔画中心线）
const STROKE = 92
const M_POINTS = [
  [236, 790],
  [236, 330],
  [512, 660],
  [788, 330],
  [788, 790],
]

const pixels = Buffer.alloc(SIZE * SIZE * 4)

for (let y = 0; y < SIZE; y += 1) {
  for (let x = 0; x < SIZE; x += 1) {
    const offset = (y * SIZE + x) * 4
    if (!inRoundedRect(x, y, SIZE, RADIUS)) continue

    // 背景：带一点纵向渐变的深色
    const t = y / SIZE
    let color = [
      Math.round(BG[0] + t * 10),
      Math.round(BG[1] + t * 12),
      Math.round(BG[2] + t * 16),
      255,
    ]

    // 内嵌面板（模拟"卡片"）
    if (inRoundedRect(x - 120, y - 150, SIZE - 240, 120)) color = PANEL

    // M 折线：逐段取最小距离
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < M_POINTS.length - 1; i += 1) {
      const [ax, ay] = M_POINTS[i]
      const [bx, by] = M_POINTS[i + 1]
      best = Math.min(best, distanceToSegment(x, y, ax, ay, bx, by))
    }
    if (best <= STROKE / 2) {
      // 抗锯齿：边缘 1.5px 过渡
      const edge = Math.min(1, Math.max(0, STROKE / 2 + 1.5 - best) / 1.5)
      color = [
        Math.round(ACCENT_SOFT[0] + (ACCENT[0] - ACCENT_SOFT[0]) * edge),
        Math.round(ACCENT_SOFT[1] + (ACCENT[1] - ACCENT_SOFT[1]) * edge),
        Math.round(ACCENT_SOFT[2] + (ACCENT[2] - ACCENT_SOFT[2]) * edge),
        255,
      ]
    }

    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
    pixels[offset + 3] = color[3]
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const target = resolve(here, '..', 'app-icon.png')
writeFileSync(target, encodePng(SIZE, SIZE, pixels))
console.log(`已生成图标源图：${target}（${SIZE}×${SIZE}）`)
