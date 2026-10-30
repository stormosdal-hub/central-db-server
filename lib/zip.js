'use strict';
/*
 * lib/zip.js - en zip-fil som strømmes mens den lages, til eksporten med én CSV-fil per kjøreverk.
 *
 * Hver fil pakkes med deflate, bit for bit: hver bit pakkes for seg og avsluttes med en sync flush, så bitene
 * kan settes etter hverandre, og en tom sluttblokk avslutter filen. CRC og størrelser kommer etter dataene
 * (data descriptor), og katalogen til slutt. Uten zip64, så hver fil og hele zip-filen må være under 4 GB.
 */

const zlib = require('zlib');

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = typeof zlib.crc32 === 'function' ? (buf, prev) => zlib.crc32(buf, prev || 0) : (buf, prev) => {
  let c = (prev || 0) ^ 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
const LIMIT = 0xFFFFFFFF;
const FINAL_BLOCK = Buffer.from([0x03, 0x00]);   // en tom, siste deflate-blokk

// files: async iterable av { name, chunks: async iterable av Buffer|string }. Gir Buffer-biter av zip-filen.
async function* zip(files) {
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for await (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);               // versjon som trengs
    local.writeUInt16LE(0x0808, 6);           // bit 3: CRC og størrelser etter dataene; bit 11: navnet er UTF-8
    local.writeUInt16LE(8, 8);                // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt16LE(name.length, 26);
    const start = offset;
    yield local; yield name;
    offset += local.length + name.length;
    let crc = 0, size = 0, csize = 0;
    for await (const chunk of f.chunks) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
      if (!buf.length) continue;
      crc = crc32(buf, crc);
      size += buf.length;
      const z = zlib.deflateRawSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      csize += z.length;
      yield z;
    }
    csize += FINAL_BLOCK.length;
    yield FINAL_BLOCK;
    if (size > LIMIT || csize > LIMIT || offset + csize > LIMIT) throw new Error(`${f.name} is larger than 4 GB, which a zip file without zip64 can't hold; export a shorter time range`);
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(csize, 8);
    desc.writeUInt32LE(size, 12);
    yield desc;
    offset += csize + desc.length;
    central.push({ name, crc, csize, size, start });
  }
  const cdStart = offset;
  for (const e of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE(20, 4);                   // laget av
    h.writeUInt16LE(20, 6);                   // trengs
    h.writeUInt16LE(0x0808, 8);
    h.writeUInt16LE(8, 10);
    h.writeUInt16LE(time, 12);
    h.writeUInt16LE(date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(e.csize, 20);
    h.writeUInt32LE(e.size, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt32LE(e.start, 42);
    yield h; yield e.name;
    offset += h.length + e.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  yield end;
}

module.exports = { zip, crc32 };
