// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a map-like grid, the track of
// a bike and three pins (two orange trackers, one grey silent one). Plain Node
// (zlib), no dependency, no logo.
// Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
const smooth = (edge, distance) => Math.min(1, Math.max(0, edge - distance + 0.5));

const DARK = [20, 26, 48];
const TEAL = [38, 64, 120];
const STREET = [90, 110, 170];
const ROAD = [140, 160, 210];
const WHITE = [240, 246, 248];
const ORANGE = [255, 140, 50];
const GREY = [140, 150, 160];
const TRACK = [120, 220, 200];

// A track of points (the ride of one bike), then three pins: [x, y, radius, color].
const TRACK_POINTS = [
  [90, 450],
  [170, 400],
  [230, 410],
  [300, 340],
  [380, 320],
  [430, 250],
  [520, 230],
  [590, 170],
];
const PINS = [
  [590, 120, 44, ORANGE],
  [250, 210, 34, ORANGE],
  [660, 380, 34, GREY],
];

function segment(x, y, [x0, y0], [x1, y1]) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy));
}

/** Inside a map pin: a disc and a point below it. */
function pin(x, y, cx, cy, r) {
  const dist = Math.hypot(x - cx, y - cy);
  let inside = smooth(r, dist);
  const depth = y - cy;
  if (depth > 0 && depth < 1.9 * r) {
    const half = r * 0.75 * (1 - depth / (1.9 * r));
    inside = Math.max(inside, smooth(half, Math.abs(x - cx)));
  }
  return { inside, dist };
}

function pixel(x, y) {
  let color = mix(DARK, TEAL, (x / WIDTH) * 0.5 + (y / HEIGHT) * 0.5);
  // The streets of a map: a light grid, two wider roads.
  if (x % 64 < 2 || y % 64 < 2) color = mix(color, STREET, 0.35);
  color = mix(color, ROAD, smooth(5, segment(x, y, [0, 300], [800, 90])) * 0.5);
  color = mix(color, ROAD, smooth(5, segment(x, y, [140, 0], [470, 534])) * 0.5);
  // The track: a line and its points.
  for (let i = 1; i < TRACK_POINTS.length; i += 1) {
    color = mix(
      color,
      TRACK,
      smooth(2.5, segment(x, y, TRACK_POINTS[i - 1], TRACK_POINTS[i])) * 0.9,
    );
  }
  for (const [px, py] of TRACK_POINTS) {
    color = mix(color, TRACK, smooth(7, Math.hypot(x - px, y - py)));
  }
  for (const [cx, cy, r, light] of PINS) {
    const { inside, dist } = pin(x, y, cx, cy, r);
    color = mix(color, light, inside);
    color = mix(color, WHITE, smooth(r * 0.42, dist));
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);
