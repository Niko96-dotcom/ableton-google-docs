// Writes .amxd files (unfrozen and frozen) and builds the patcher JSON.
// An .amxd is a list of chunks: 4-byte ASCII tag, little-endian uint32 size,
// data. In an unfrozen device the patch chunk holds the patcher as JSON,
// ended by a NUL byte; for frozen devices see "frozen devices" below.

const DEVICE_TYPES = { audio: 'aaaa', midi: 'mmmm', instrument: 'iiii' };

function chunk(tag, data) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}

export function encodeAmxd(patcher, type = 'audio') {
  const json = Buffer.from(JSON.stringify({ patcher }, null, '\t') + '\n\0', 'utf8');
  return Buffer.concat([chunk('ampf', Buffer.from(DEVICE_TYPES[type], 'ascii')), chunk('meta', Buffer.alloc(4)), chunk('ptch', json)]);
}

function chunks(buffer) {
  const found = {};
  for (let pos = 0; pos + 8 <= buffer.length; ) {
    const size = buffer.readUInt32LE(pos + 4);
    found[buffer.toString('ascii', pos, pos + 4)] = buffer.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size;
  }
  return found;
}

// The patcher of an unfrozen device.
export function decodeAmxd(buffer) {
  const { ptch } = chunks(buffer);
  if (ptch.toString('ascii', 0, 4) === 'mx@c') throw new Error('frozen device: use decodeFrozenAmxd');
  return JSON.parse(ptch.toString('utf8').replace(/\0+$/, '')).patcher;
}

// ---- frozen devices
// A frozen device carries the patcher and the files it needs in one .amxd.
// Its ptch chunk is a container (read from a device that Max 9.1.5 froze):
//   "mx@c", header size 16, 0, offset of the file list (big-endian uint32);
//   the files, one after another, the patcher JSON first;
//   the file list "dlst": one "dire" per file with the fields type (JSON or
//   TEXT), fnam (name, NUL-ended, padded to 4 bytes), sz32, of32, vers,
//   flag (17 for the patcher, 8 for a file it needs) and mdat (seconds
//   since 1904). Every chunk in the container: tag, big-endian size with
//   the 8 header bytes, data.
// The meta chunk of a frozen device holds 7.
const MAC_EPOCH = 2082844800;
const be32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const field = (tag, data) => Buffer.concat([Buffer.from(tag, 'ascii'), be32(data.length + 8), data]);
const cString = (s) => {
  const raw = Buffer.from(`${s}\0`, 'utf8');
  return Buffer.concat([raw, Buffer.alloc((4 - (raw.length % 4)) % 4)]);
};

// entries: [{ kind: 'JSON' | 'TEXT', name, data: Buffer, flag, mdat }]
export function freeze(entries, type = 'audio') {
  let offset = 16;
  const dires = entries.map((e) => {
    const dire = field(
      'dire',
      Buffer.concat([
        field('type', Buffer.from(e.kind, 'ascii')),
        field('fnam', cString(e.name)),
        field('sz32', be32(e.data.length)),
        field('of32', be32(offset)),
        field('vers', be32(0)),
        field('flag', be32(e.flag)),
        field('mdat', be32(e.mdat)),
      ]),
    );
    offset += e.data.length;
    return dire;
  });
  const container = Buffer.concat([Buffer.from('mx@c', 'ascii'), be32(16), be32(0), be32(offset), ...entries.map((e) => e.data), field('dlst', Buffer.concat(dires))]);
  return Buffer.concat([chunk('ampf', Buffer.from(DEVICE_TYPES[type], 'ascii')), chunk('meta', Buffer.from([7, 0, 0, 0])), chunk('ptch', container)]);
}

export function decodeFrozenAmxd(buffer) {
  const { ptch } = chunks(buffer);
  if (ptch.toString('ascii', 0, 4) !== 'mx@c') throw new Error('not a frozen device');
  const list = ptch.subarray(ptch.readUInt32BE(12));
  if (list.toString('ascii', 0, 4) !== 'dlst') throw new Error('no file list');
  const entries = [];
  for (let pos = 8; pos < list.readUInt32BE(4); pos += list.readUInt32BE(pos + 4)) {
    const fields = {};
    const end = pos + list.readUInt32BE(pos + 4);
    for (let q = pos + 8; q < end; q += list.readUInt32BE(q + 4)) {
      fields[list.toString('ascii', q, q + 4)] = list.subarray(q + 8, q + list.readUInt32BE(q + 4));
    }
    const of32 = fields.of32.readUInt32BE();
    entries.push({
      kind: fields.type.toString('ascii'),
      name: fields.fnam.toString('utf8').replace(/\0+$/, ''),
      data: ptch.subarray(of32, of32 + fields.sz32.readUInt32BE()),
      flag: fields.flag.readUInt32BE(),
      mdat: fields.mdat.readUInt32BE(),
    });
  }
  return entries;
}

// The project block that Max writes into a frozen device's patcher.
function project(mdat, type) {
  return {
    version: 1,
    creationdate: mdat,
    modificationdate: mdat,
    viewrect: [0, 0, 300, 500],
    autoorganize: 1,
    hideprojectwindow: 1,
    showdependencies: 1,
    autolocalize: 0,
    contents: { patchers: {} },
    layout: {},
    searchpath: {},
    detailsvisible: 0,
    amxdtype: Buffer.from(DEVICE_TYPES[type], 'ascii').readUInt32BE(),
    readonly: 0,
    devpathtype: 0,
    devpath: '.',
    sortmode: 0,
    viewmode: 0,
    includepackages: 0,
  };
}

// A frozen device named `name` from a patcher and the text files it refers
// to by name: files [{ name, text }].
export function encodeFrozenAmxd(patcher, name, files, { type = 'audio', date = new Date() } = {}) {
  const mdat = Math.floor(date.getTime() / 1000) + MAC_EPOCH;
  const json = Buffer.from(`${JSON.stringify({ patcher: { ...patcher, project: project(mdat, type) } }, null, '\t')}\n\0`, 'utf8');
  return freeze(
    [{ kind: 'JSON', name, data: json, flag: 0x11, mdat }, ...files.map((f) => ({ kind: 'TEXT', name: f.name, data: Buffer.from(f.text, 'utf8'), flag: 0x08, mdat }))],
    type,
  );
}

// Boxes get ids in the order they are added. A patch is the main device
// patcher or a subpatcher; subpatchers go into a `p` box (see Patch#sub).
export class Patch {
  constructor({ rect = [100, 100, 900, 600], ...props } = {}) {
    this.rect = rect;
    this.props = props;
    this.boxes = [];
    this.lines = [];
    this.count = 0;
    this.y = 20;
  }

  add(props) {
    const id = `obj-${++this.count}`;
    this.boxes.push({ box: { id, numinlets: 1, numoutlets: 0, patching_rect: [20, this.y, 160, 22], ...props } });
    this.y += 32;
    return id;
  }

  obj(text, { inlets = 1, outlets = 1, outlettype, ...rest } = {}) {
    return this.add({ maxclass: 'newobj', text, numinlets: inlets, numoutlets: outlets, outlettype: outlettype ?? Array(outlets).fill(''), ...rest });
  }

  msg(text) {
    return this.add({ maxclass: 'message', text, numinlets: 2, numoutlets: 1, outlettype: [''] });
  }

  // A `p <name>` box. Its inlets and outlets are the inlet and outlet
  // objects inside `inner`, in the order they were added.
  sub(name, inner, rest = {}) {
    const inlets = inner.boxes.filter((b) => b.box.maxclass === 'inlet').length;
    const outlets = inner.boxes.filter((b) => b.box.maxclass === 'outlet').length;
    return this.obj(`p "${name}"`, { inlets, outlets, patcher: inner.toPatcher(), ...rest });
  }

  connect(source, outlet, destination, inlet = 0) {
    for (const [kind, index] of [['outlet', outlet], ['inlet', inlet]]) {
      if (!Number.isInteger(index) || index < 0) throw new Error(`connect ${source} -> ${destination}: the ${kind} must be a whole number, got ${index}`);
    }
    this.lines.push({ patchline: { source: [source, outlet], destination: [destination, inlet] } });
  }

  toPatcher() {
    return {
      fileversion: 1,
      appversion: { major: 9, minor: 1, revision: 5, architecture: 'x64', modernui: 1 },
      classnamespace: 'box',
      rect: this.rect,
      default_fontsize: 10,
      default_fontface: 0,
      default_fontname: 'Arial Bold',
      gridsize: [8, 8],
      boxes: this.boxes,
      lines: this.lines,
      ...this.props,
    };
  }
}
