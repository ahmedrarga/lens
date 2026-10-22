// Minimal streaming ustar reader: GNU 'L' long names and pax 'x' `path=` records.
export interface TarEntry {
  path: string;
  /** Typeflag character; '0' (or NUL) is a regular file. */
  type: string;
  size: number;
  /** File bytes, or null when `wantData` declined it (the bytes are skipped, not buffered). */
  data: Buffer | null;
}

const BLOCK = 512;

const str = (b: Buffer, from: number, len: number) => {
  const s = b.subarray(from, from + len);
  const nul = s.indexOf(0);
  return s.subarray(0, nul < 0 ? s.length : nul).toString('utf8');
};

function parseSize(b: Buffer): number {
  if (b[124]! & 0x80) { // base-256 for huge files
    let n = b[124]! & 0x7f;
    for (let i = 125; i < 136; i++) n = n * 256 + b[i]!;
    return n;
  }
  return parseInt(str(b, 124, 12).trim() || '0', 8);
}

function parsePax(data: Buffer): string | undefined {
  let pos = 0;
  let path: string | undefined;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) break;
    const len = parseInt(data.subarray(pos, sp).toString(), 10);
    if (!(len > 0)) break;
    const rec = data.subarray(sp + 1, pos + len - 1).toString('utf8'); // drop trailing \n
    if (rec.startsWith('path=')) path = rec.slice(5);
    pos += len;
  }
  return path;
}

export async function* untar(
  source: AsyncIterable<Uint8Array>,
  wantData: (e: { path: string; type: string; size: number }) => boolean = () => true,
): AsyncGenerator<TarEntry> {
  const it = source[Symbol.asyncIterator]();
  let buf: Buffer = Buffer.alloc(0);
  let ended = false;
  const fill = async (n: number) => {
    const parts = [buf];
    let have = buf.length;
    while (have < n && !ended) {
      const r = await it.next();
      if (r.done) ended = true;
      else { parts.push(Buffer.from(r.value.buffer, r.value.byteOffset, r.value.byteLength)); have += r.value.byteLength; }
    }
    if (parts.length > 1) buf = Buffer.concat(parts);
    return buf.length >= n;
  };
  /** Read `size` payload bytes (kept or dropped) and consume the block padding. */
  const body = async (size: number, keep: boolean): Promise<Buffer | null> => {
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    const out: Buffer[] = [];
    let left = padded;
    while (left > 0) {
      if (!(await fill(1))) throw new Error('tar: unexpected end of archive');
      const take = Math.min(left, buf.length);
      if (keep) out.push(buf.subarray(0, take));
      buf = buf.subarray(take);
      left -= take;
    }
    return keep ? Buffer.concat(out).subarray(0, size) : null;
  };

  let longName: string | undefined;
  let paxPath: string | undefined;
  while (await fill(BLOCK)) {
    const h = buf.subarray(0, BLOCK);
    buf = buf.subarray(BLOCK);
    if (h.every((x) => x === 0)) continue;
    const type = String.fromCharCode(h[156] || 0x30);
    const size = parseSize(h);
    let path = str(h, 0, 100);
    if (str(h, 257, 5) === 'ustar') {
      const prefix = str(h, 345, 155);
      if (prefix) path = `${prefix}/${path}`;
    }
    if (type === 'L') { longName = (await body(size, true))!.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x') { paxPath = parsePax((await body(size, true))!); continue; }
    if (type === 'g') { await body(size, false); continue; }
    path = paxPath ?? longName ?? path;
    longName = paxPath = undefined;
    const keep = wantData({ path, type, size });
    yield { path, type, size, data: await body(size, keep) };
  }
}
