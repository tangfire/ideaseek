import { crc32, deflateRawSync, gzipSync } from 'node:zlib';

/**
 * Programmatic archive fixture builders for the archive intake tests.
 * Everything is generated in-memory so no binary fixtures are committed and
 * every dangerous shape (traversal, symlinks, bombs, encryption flags) can be
 * constructed precisely.
 */

export interface ZipEntrySpec {
  name: string;
  data?: string | Buffer;
  /** 0 = stored, 8 = deflate (default). */
  method?: 0 | 8;
  encrypted?: boolean;
  /** Unix mode placed in external attributes (e.g. 0o120777 for a symlink). */
  unixMode?: number;
}

function toBuffer(data: string | Buffer | undefined): Buffer {
  if (data === undefined) return Buffer.alloc(0);
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

export function buildZip(entries: ZipEntrySpec[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = toBuffer(entry.data);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const method = entry.method ?? 8;
    const payload = method === 0 ? data : deflateRawSync(data);
    const crc = crc32(data) >>> 0;
    const flags = (entry.encrypted ? 1 : 0) | 0x0800; // bit0 = encrypted, bit11 = UTF-8

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    localParts.push(local, nameBuf, payload);
    const localOffset = offset;
    offset += 30 + nameBuf.length + payload.length;

    const mode = entry.unixMode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(payload.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE((mode << 16) >>> 0, 38);
    cd.writeUInt32LE(localOffset, 42);
    centralParts.push(cd, nameBuf);
  }

  const centralSize = centralParts.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export interface TarEntrySpec {
  name: string;
  data?: string | Buffer;
  type?: 'file' | 'dir' | 'symlink' | 'hardlink' | 'chardev' | 'fifo';
  linkName?: string;
  /** Corrupts the header checksum (structural damage fixture). */
  badChecksum?: boolean;
  /** Declares a different size than the bytes written (truncation fixture). */
  declaredSizeOverride?: number;
  mode?: number;
}

const TAR_TYPE_FLAG: Record<NonNullable<TarEntrySpec['type']>, string> = {
  file: '0',
  dir: '5',
  symlink: '2',
  hardlink: '1',
  chardev: '3',
  fifo: '6',
};

function writeOctalField(buf: Buffer, offset: number, length: number, value: number): void {
  const digits = length - 1;
  const text = value.toString(8).padStart(digits, '0').slice(-digits);
  buf.write(text, offset, digits, 'ascii');
  buf.writeUInt8(0, offset + digits);
}

function pad512(data: Buffer): Buffer {
  const remainder = data.length % 512;
  return remainder === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - remainder)]);
}

function tarHeader(opts: {
  name: string;
  size: number;
  typeFlag: string;
  linkName: string;
  mode: number;
  mtime: number;
  badChecksum: boolean;
}): Buffer {
  const header = Buffer.alloc(512);
  header.write(opts.name, 0, Math.min(100, Buffer.byteLength(opts.name)), 'utf8');
  writeOctalField(header, 100, 8, opts.mode);
  writeOctalField(header, 108, 8, 0); // uid
  writeOctalField(header, 116, 8, 0); // gid
  writeOctalField(header, 124, 12, opts.size);
  writeOctalField(header, 136, 12, opts.mtime);
  header.fill(0x20, 148, 156); // checksum field placeholder: spaces
  header.write(opts.typeFlag, 156, 1, 'ascii');
  header.write(opts.linkName, 157, Math.min(100, Buffer.byteLength(opts.linkName)), 'utf8');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 4, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i]!;
  const stored = opts.badChecksum ? sum + 1 : sum;
  header.write(stored.toString(8).padStart(6, '0'), 148, 6, 'ascii');
  header.writeUInt8(0, 154);
  header.writeUInt8(0x20, 155);
  return header;
}

function paxRecordString(key: string, value: string): string {
  const body = `${key}=${value}\n`;
  let length = body.length + 2;
  for (;;) {
    const record = `${length} ${body}`;
    if (record.length === length) return record;
    length = record.length;
  }
}

export function buildTar(entries: TarEntrySpec[], opts: { omitEof?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const type = entry.type ?? 'file';
    const data = toBuffer(entry.data);
    let name = entry.name;
    let linkName = entry.linkName ?? '';

    const nameTooLong = Buffer.byteLength(name, 'utf8') > 100;
    const linkTooLong = Buffer.byteLength(linkName, 'utf8') > 100;
    if (nameTooLong || linkTooLong) {
      let records = '';
      if (nameTooLong) records += paxRecordString('path', name);
      if (linkTooLong) records += paxRecordString('linkpath', linkName);
      const paxData = Buffer.from(records, 'utf8');
      parts.push(
        tarHeader({
          name: 'PaxHeader.0',
          size: paxData.length,
          typeFlag: 'x',
          linkName: '',
          mode: 0o644,
          mtime: 0,
          badChecksum: false,
        }),
        pad512(paxData),
      );
      name = name.slice(0, 100);
      linkName = linkName.slice(0, 100);
    }

    const isFile = type === 'file';
    const declaredSize =
      isFile && entry.declaredSizeOverride !== undefined
        ? entry.declaredSizeOverride
        : isFile
          ? data.length
          : 0;
    parts.push(
      tarHeader({
        name,
        size: declaredSize,
        typeFlag: TAR_TYPE_FLAG[type],
        linkName,
        mode: entry.mode ?? (type === 'dir' ? 0o755 : 0o644),
        mtime: 0,
        badChecksum: entry.badChecksum ?? false,
      }),
    );
    if (isFile) {
      if (entry.declaredSizeOverride !== undefined && entry.declaredSizeOverride !== data.length) {
        parts.push(data); // no padding: truncation/lying-size fixture
      } else {
        parts.push(pad512(data));
      }
    }
  }
  if (!opts.omitEof) parts.push(Buffer.alloc(1024)); // two zero blocks
  return Buffer.concat(parts);
}

export function buildTarGz(entries: TarEntrySpec[], opts: { omitEof?: boolean } = {}): Buffer {
  return gzipSync(buildTar(entries, opts));
}
