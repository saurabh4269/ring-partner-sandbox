// Placeholder media for the snapshot endpoint. Zero dependencies:
// - JPEG: a small 320x180 still embedded as base64 (generated once, checked in).
// - PNG: generated on the fly with node:zlib.
import { deflateSync } from 'node:zlib';

const JPEG_B64 = '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ACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigArpq5mumrkxXQ6sP1CiiiuM6gooooAKKKKACiiigArnrr/AI+pv99v510Nc9df8fU3++3866sNuzmxGyIqKKK7TkCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigArpq5mumrkxXQ6sP1CiiiuM6gooooAKKKKACiiigArnrr/j6m/wB9v510Nc9df8fU3++3866sNuzmxGyIqKKK7TkCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigArpq5mumrkxXQ6sP1CiiiuM6gooooAKKKKACitXw1/yH7b/gf/oJrstU/wCQTef9cH/9BNZTqcsrWA84rnrr/j6m/wB9v510Nc9df8fU3++38678NuzmxGyIqKKK7TkCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigArpq5mumrkxXQ6sP1CiiiuM6gooooAKKKKAHxSyQyCSKRo3HRlOCPxqZ9SvnQo97cMrDBBlYgj86rUUrIArnrr/j6m/32/nXQ1z11/x9Tf77fzrrw27ObEbIiooortOQKKKKACiiigAooooAKKKKACiiigAooooAKK1qKy9p5FWMmitaij2nkFjJorWoo9p5BYyaK1qKPaeQWMmitaij2nkFjJorWoo9p5BYyaK1qKPaeQWMmumrPrQrmxEuax00OoUUUVzHSFFFFABRRRQAUUUUAFc9df8AH1N/vt/OuhqjJ/rG+prooSs2c9fZGPRWtRXV7TyOWxk0VrUUe08gsZNFa1FHtPILGTRWtRR7TyCxk0VrUUe08gsZNFa1FHtPILGTRWtRR7TyCwUUUVmMKKKKACiiigAooooAKKKKACiiigAooooAK0Kz6tfak9GrGrFu1jejJK9yaioftSejUfak9GrLkl2NvaR7k1FQ/ak9Go+1J6NRyS7B7SPcmoqH7Uno1H2pPRqOSXYPaR7k1FQ/ak9Go+1J6NRyS7B7SPcmqjJ/rG+pqx9qT0aq7Hc5I7nNaU4tPUxqyTSsNooorcwCiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAK17nRktobh0uPOWOHzA/l4Vv3iL8pBII+f68cgVk1bm1W9uI3jklBWQEOBGq7ssrEnA6kovPXigC/c6BBC0yJfs7xvOgBgwGaFdzfxcDBGD6/nVOTTPL+0fvs+RaxXH3eu/wAv5evbzOvt71G+qXruztNlneV2O0cmRdrnp3H5dsUrapeNatbGVTG6LG37tdzKpBUFsZOMDHPagDQ1DRIYn1CaORo47eZ9sezOIxLs4JOSRke3vmnajoEFvPdGO7VEVpTCkhQEqjMMH5s5ypAwDnjp2z59Zv7mKWOaZWWYEP8AukBILbyMgZxu5+ufWibWL6cSCSZSZM7m8tQefvYIGRnvjrk+poAsXem29np11+8aS6t7qOF8ptCHbJuA55GVHOB096fJocEXmu18xhihMvmLDkPh1X5fmwQd/qDxyBVGfU7y5gMEsoZCyucIoLMAQCSBknBPWlm1W9uI3jklBWQEOBGq7ssrEnA6kovPXigC5/YIKzlbkkJF5sZMeA6+UJeeeDtPQZ59uadFoUEr+X/aG11t455A0YACuqkAEtycso5wOetUxrF+sZjEwKlNnMakhdgjIBxxlQBx1xUkuu3bMnklYlSGOIjYrbgqBeTjkHBODkc0AWxols0dvbtPJHcTXjwIzQnLfLGVDAn5QCx5GevcU3TtEgnvbaGa4YsTC80apwEkZQMNnr86544z3xVBtVvWmhlMw3wS+bHhFAVsKBgYxjCKMdOKE1W9iSJUm2+UVKsEXd8pyuTjJAPY8UAVXCh2CEsuflJGCR9O1NpzsXdnOAWOTgAD8h0ptABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH/2Q==';

export const placeholderJpeg = () => Buffer.from(JPEG_B64, 'base64');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** A simple valid RGB PNG: dark "sky", lighter "ground", a door-ish rectangle. */
export function placeholderPng(width = 320, height = 180) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let rgb = y > height * 0.66 ? [70, 80, 70] : [38, 50, 64];
      if (x > width * 0.375 && x < width * 0.625 && y > height * 0.22 && y < height * 0.78) rgb = [120, 90, 60];
      raw.set(rgb, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
