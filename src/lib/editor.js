// Editable view model on top of a parsed SII image.
//
// The EEPROM parser page clones `parseSii`'s result into this shape, edits it
// in place, and hands it back to the ESI XML generator. Names and the SII
// string table stay in sync: editing a name rewrites the string entry it
// references (creating one when the name had none), and editing or deleting a
// string updates every field that points at it.
//
// SII-only fields (serial number, hardware delays, ...) are kept in the model
// so they can be inspected and edited; the generator warns about the ones ESI
// cannot carry.

import { DATA_TYPE_NAMES, FMMU_USAGE } from './sii.js'

const clone = (value) => JSON.parse(JSON.stringify(value))

function emptyMailbox() {
  return { rxOffset: 0, rxSize: 0, txOffset: 0, txSize: 0 }
}

export function emptyInfo() {
  return {
    pdiControl: 0,
    pdiConfiguration: 0,
    syncImpulseLength: 0,
    pdiConfiguration2: 0,
    stationAlias: 0,
    reserved1: 0,
    reserved2: 0,
    checksumStored: null,
    checksumComputed: null,
    checksumValid: null,
    vendorId: 0,
    productCode: 0,
    revisionNumber: 0,
    serialNumber: 0,
    executionDelay: 0,
    port0Delay: 0,
    port1Delay: 0,
    bootstrap: emptyMailbox(),
    standard: emptyMailbox(),
    mailboxProtocols: 0,
    eepromSizeRaw: 15,
    eepromSizeBytes: 2048,
    eepromVersion: 1,
  }
}

export function defaultGeneral() {
  return {
    groupStringIndex: 0,
    imageStringIndex: 0,
    orderStringIndex: 0,
    nameStringIndex: 0,
    reserved: 1,
    coeDetails: 0,
    foeDetails: 0,
    eoeDetails: 0,
    soeChannels: 0,
    ds402Channels: 0,
    sysmanClass: 0,
    flags: 0,
    ebusCurrent: 0,
    portsWord: 0,
    ports: [0, 0, 0, 0],
    physicalMemoryAddress: 0x0002,
    groupName: '',
    imageName: '',
    orderName: '',
    deviceName: '',
  }
}

export function createEmptyModel() {
  return {
    info: emptyInfo(),
    general: defaultGeneral(),
    strings: [],
    fmmus: [],
    syncManagers: [],
    txPdos: [],
    rxPdos: [],
    dc: { elements: [] },
  }
}

export function createEditorModel(parsed) {
  const model = createEmptyModel()
  if (!parsed) return model

  if (parsed.info) {
    model.info = clone(parsed.info)
    model.info.bootstrap = { ...emptyMailbox(), ...(model.info.bootstrap || {}) }
    model.info.standard = { ...emptyMailbox(), ...(model.info.standard || {}) }
  }
  if (parsed.general) {
    model.general = { ...defaultGeneral(), ...clone(parsed.general) }
    model.general.ports = Array.isArray(model.general.ports)
      ? [...model.general.ports]
      : [0, 0, 0, 0]
  }

  model.strings = (parsed.strings || []).map((entry) => clone(entry))
  model.fmmus = (parsed.fmmus || []).map((entry) => clone(entry))
  model.syncManagers = (parsed.syncManagers || []).map((entry) => clone(entry))
  model.txPdos = (parsed.txPdos || []).map((pdo) => clone(pdo))
  model.rxPdos = (parsed.rxPdos || []).map((pdo) => clone(pdo))
  model.dc = { elements: (parsed.dc?.elements || []).map((element) => clone(element)) }
  return model
}

// An SII image only stores the data type code; the generator wants an ESI type
// name, so derive it and blank unknown codes to make the generator warn.
function withDataTypeName(pdo) {
  return {
    ...pdo,
    entries: pdo.entries.map((entry) => ({
      ...entry,
      dataTypeName: DATA_TYPE_NAMES[entry.dataType] || '',
    })),
  }
}

export function editorResult(model, bytes = new Uint8Array(0)) {
  return {
    bytes,
    byteLength: bytes.length,
    info: model.info,
    general: model.general,
    fmmus: model.fmmus,
    syncManagers: model.syncManagers,
    txPdos: model.txPdos.map(withDataTypeName),
    rxPdos: model.rxPdos.map(withDataTypeName),
    dc: model.dc,
  }
}

function wordsToHex(words) {
  const bytes = []
  for (const word of words) {
    const value = Number(word) || 0
    bytes.push(value & 0xff, (value >>> 8) & 0xff)
  }
  return bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('')
}

// Eeprom/ConfigData covers the first five header words and Eeprom/BootStrap the
// four bootstrap mailbox words, so header edits reach the exported XML.
export function editorOptions(model, vendorName = '') {
  const { info } = model
  return {
    vendorName: vendorName || 'Vendor (SII image)',
    configData: wordsToHex([
      info.pdiControl,
      info.pdiConfiguration,
      info.syncImpulseLength,
      info.pdiConfiguration2,
      info.stationAlias,
    ]),
    bootStrap: wordsToHex([
      info.bootstrap.rxOffset,
      info.bootstrap.rxSize,
      info.bootstrap.txOffset,
      info.bootstrap.txSize,
    ]),
  }
}

// ---------------------------------------------------------------------------
// String table <-> name fields
// ---------------------------------------------------------------------------

export function latin1Bytes(text) {
  const bytes = []
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0)
    bytes.push(code <= 0xff ? code : 0x3f)
  }
  return bytes
}

export function stringByteLength(text) {
  let length = 0
  for (const _char of String(text ?? '')) length += 1
  return length
}

function nameSlots(model) {
  const slots = []
  const general = model.general
  if (general) {
    slots.push([general, 'groupName', 'groupStringIndex'])
    slots.push([general, 'imageName', 'imageStringIndex'])
    slots.push([general, 'orderName', 'orderStringIndex'])
    slots.push([general, 'deviceName', 'nameStringIndex'])
  }
  for (const pdo of [...model.txPdos, ...model.rxPdos]) {
    slots.push([pdo, 'name', 'nameIndex'])
    for (const entry of pdo.entries) slots.push([entry, 'name', 'nameIndex'])
  }
  for (const element of model.dc.elements) {
    slots.push([element, 'name', 'nameIndex'])
    slots.push([element, 'description', 'descIndex'])
  }
  return slots
}

function writeStringEntry(entry, text) {
  const value = String(text ?? '')
  entry.text = value
  entry.raw = latin1Bytes(value)
  entry.length = entry.raw.length
}

function nextStringIndex(model) {
  return model.strings.reduce((max, entry) => Math.max(max, entry.index), 0) + 1
}

export function setStringText(model, index, text) {
  const entry = model.strings.find((item) => item.index === index)
  if (!entry) return
  writeStringEntry(entry, text)
  for (const [owner, nameKey, indexKey] of nameSlots(model)) {
    if (owner[indexKey] === index) owner[nameKey] = text
  }
}

function sharedStringCount(model, index) {
  let count = 0
  for (const [owner, , indexKey] of nameSlots(model)) {
    if (owner[indexKey] === index) count += 1
  }
  return count
}

// Writes a name field and the string entry behind it. A name that had no string
// index gets a new entry so the table always reflects what the XML will carry.
// SII tables often dedupe equal names onto one entry; editing one of those
// fields must not rename the others, so it is detached onto a fresh entry.
export function setName(model, owner, nameKey, indexKey, text) {
  const value = String(text ?? '')
  owner[nameKey] = value

  let index = owner[indexKey]
  if (index && sharedStringCount(model, index) > 1) {
    owner[indexKey] = 0
    index = 0
  }

  if (!index) {
    if (!value) return
    index = addString(model)
    owner[indexKey] = index
  }

  const entry = model.strings.find((item) => item.index === index)
  if (entry) writeStringEntry(entry, value)
}

export function addString(model) {
  const index = nextStringIndex(model)
  model.strings.push({ index, length: 0, text: '', raw: [] })
  return index
}

export function removeString(model, index) {
  const position = model.strings.findIndex((entry) => entry.index === index)
  if (position < 0) return
  model.strings.splice(position, 1)

  // SII string indices are positions in the table, so everything after the
  // removed entry shifts down by one.
  const remap = new Map()
  model.strings.forEach((entry, position) => {
    remap.set(entry.index, position + 1)
    entry.index = position + 1
  })

  for (const [owner, nameKey, indexKey] of nameSlots(model)) {
    const ref = owner[indexKey]
    if (!ref) continue
    if (ref === index) {
      owner[indexKey] = 0
      owner[nameKey] = ''
    } else if (remap.has(ref)) {
      owner[indexKey] = remap.get(ref)
    }
  }
}

export function referencedStringIndices(model) {
  const used = new Set()
  for (const [owner, , indexKey] of nameSlots(model)) {
    if (owner[indexKey]) used.add(owner[indexKey])
  }
  return used
}

export function unreferencedStrings(model) {
  const used = referencedStringIndices(model)
  return model.strings.filter((entry) => !used.has(entry.index))
}

// ---------------------------------------------------------------------------
// Entry CRUD
// ---------------------------------------------------------------------------

export function addFmmu(model) {
  model.fmmus.push({ usage: 0x01, label: FMMU_USAGE[0x01] })
}

export function removeFmmu(model, position) {
  model.fmmus.splice(position, 1)
}

export function addSyncManager(model) {
  const index = model.syncManagers.length
  model.syncManagers.push({
    index,
    startAddress: 0,
    length: 0,
    control: 0,
    status: 0,
    enable: 0x01,
    type: (index + 1) & 0xff,
  })
}

export function removeSyncManager(model, position) {
  const [removed] = model.syncManagers.splice(position, 1)
  model.syncManagers.forEach((manager, index) => {
    manager.index = index
  })
  if (!removed) return

  // PDOs reference SyncManagers by index: drop the deleted one and shift the
  // rest down with the list.
  for (const pdo of [...model.txPdos, ...model.rxPdos]) {
    if (pdo.syncManager === 0xff) continue
    if (pdo.syncManager === position) pdo.syncManager = 0xff
    else if (pdo.syncManager > position) pdo.syncManager -= 1
  }
}

function pdoList(model, kind) {
  return kind === 'tx' ? model.txPdos : model.rxPdos
}

export function addPdo(model, kind) {
  const list = pdoList(model, kind)
  list.push({
    index: (kind === 'tx' ? 0x1a00 : 0x1600) + list.length,
    syncManager: kind === 'tx' ? 3 : 2,
    synchronization: 0,
    nameIndex: 0,
    name: '',
    flags: 0x1000,
    entries: [],
  })
}

export function removePdo(model, kind, position) {
  pdoList(model, kind).splice(position, 1)
}

export function addEntry(model, kind, pdoPosition) {
  const pdo = pdoList(model, kind)[pdoPosition]
  if (!pdo) return
  pdo.entries.push({
    index: 0x0000,
    subIndex: pdo.entries.length,
    nameIndex: 0,
    name: '',
    dataType: 5,
    dataTypeName: DATA_TYPE_NAMES[5],
    bitLength: 8,
    flags: 0x1000,
  })
}

export function removeEntry(model, kind, pdoPosition, entryPosition) {
  const pdo = pdoList(model, kind)[pdoPosition]
  if (!pdo) return
  pdo.entries.splice(entryPosition, 1)
}

export function addDcOpMode(model) {
  model.dc.elements.push({
    index: model.dc.elements.length,
    nameIndex: 0,
    descIndex: 0,
    name: '',
    description: '',
    assignActivate: 0,
    sync0CycleTime: 0,
    sync0ShiftTime: 0,
    sync1ShiftTime: 0,
    sync1CycleFactor: 0,
    sync0CycleFactor: 1,
    raw: [],
  })
}

export function removeDcOpMode(model, position) {
  model.dc.elements.splice(position, 1)
  model.dc.elements.forEach((element, index) => {
    element.index = index
  })
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

export function portsWord(ports) {
  let word = 0
  for (let index = 0; index < Math.min(ports?.length || 0, 4); index++) {
    word |= (Number(ports[index]) & 0x0f) << (index * 4)
  }
  return word
}

export function dcRaw(element) {
  const bytes = new Array(24).fill(0)
  const write16 = (offset, value) => {
    const word = Number(value) || 0
    bytes[offset] = word & 0xff
    bytes[offset + 1] = (word >>> 8) & 0xff
  }
  const write32 = (offset, value) => {
    const word = Number(value) >>> 0
    for (let index = 0; index < 4; index++) {
      bytes[offset + index] = (word >>> (8 * index)) & 0xff
    }
  }

  write32(0x00, element.sync0CycleTime)
  write32(0x04, element.sync0ShiftTime)
  write32(0x08, element.sync1ShiftTime)
  write16(0x0c, element.sync1CycleFactor)
  write16(0x0e, element.assignActivate)
  write16(0x10, element.sync0CycleFactor ?? 1)
  bytes[0x12] = Number(element.nameIndex) & 0xff
  bytes[0x13] = Number(element.descIndex) & 0xff
  return bytes
}
