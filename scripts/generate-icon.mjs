import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const width = 512;
const height = 512;
const pixels = Buffer.alloc(width * height * 4);
const dark = [24, 32, 21];

const pixel = (x, y, [r, g, b]) => {
  const offset = (y * width + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = 255;
};

const fill = (x0, y0, x1, y1, color) => {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) pixel(x, y, color);
  }
};

fill(0, 0, width, height, [198, 241, 109]);
fill(145, 112, 222, 400, dark);
fill(210, 112, 292, 182, dark);
fill(210, 270, 292, 340, dark);
for (let y = 112; y < 340; y += 1) {
  for (let x = 250; x < 394; x += 1) {
    const outer = ((x - 282) / 112) ** 2 + ((y - 226) / 114) ** 2 <= 1;
    const inner = ((x - 278) / 52) ** 2 + ((y - 226) / 55) ** 2 <= 1;
    if (outer && !inner) pixel(x, y, dark);
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

const crc = (buffer) => {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  const checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
};

const scanlines = [];
for (let y = 0; y < height; y += 1) {
  scanlines.push(Buffer.from([0]));
  scanlines.push(pixels.subarray(y * width * 4, (y + 1) * width * 4));
}

const header = Buffer.alloc(13);
header.writeUInt32BE(width, 0);
header.writeUInt32BE(height, 4);
header[8] = 8;
header[9] = 6;

await writeFile(
  new URL("../src-tauri/icons/icon.png", import.meta.url),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(scanlines))),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
