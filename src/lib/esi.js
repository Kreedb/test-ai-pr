// EtherCAT ESI (EtherCATInfo XML) to SII EEPROM image generator, plus the
// reverse export used by the parser to turn a parsed image back into ESI XML.
// `parseEsiXml` reads a device description into the same model the parser
// produces, so the XML editor page can start from either source.
//
// The generated layout follows what TwinCAT's EEPROM export produces for the
// reference pair `Box 1 (Limx EtherCAT).bin` / `Limx Tron2 Driver_new.xml`:
//
//   fixed header 0x00..0x7F
//   Strings, General, FMMU, SyncManager, TxPDO, RxPDO, DC, End
//
// References:
//   ETG.2000 (EtherCATInfo.xsd), ETG.2010 Table 2/6/12/14, ETG.1000.6 Table 21
//
// The ESI -> SII mapping is intentionally limited to what the SII image can
// hold: object dictionaries, InitCmds, comments and image data are dropped.
// Warnings are collected instead of throwing so the UI can show a partial
// result.

import {
  CATEGORY_TYPE,
  DATA_TYPE_NAMES,
  HEADER_BYTES,
  MAX_INPUT_BYTES,
  categoryName,
  crc8Sii,
} from './sii.js'

const GENERAL_CATEGORY_BYTES = 32
const PDO_ENTRY_FLAGS = 0x1000

const MAILBOX_PROTOCOL_BITS = {
  AoE: 0x01,
  EoE: 0x02,
  CoE: 0x04,
  FoE: 0x08,
  SoE: 0x10,
  VoE: 0x20,
}

const PORT_TYPE_BY_PHYSICS = {
  Y: 1, // MII / 100BASE-TX
  E: 3, // EBUS
  K: 4, // Fast Hot Connect
}

const FMMU_USAGE_BY_NAME = {
  Outputs: 0x01,
  Inputs: 0x02,
  MBoxState: 0x03,
}

const FMMU_NAME_BY_USAGE = {
  0x00: 'Out',
  0x01: 'Outputs',
  0x02: 'Inputs',
  0x03: 'MBoxState',
}

const PORT_PHYSICS_BY_TYPE = {
  1: 'Y',
  3: 'E',
  4: 'K',
}

// ESI / IEC 61131 type names to the SII data type codes of ETG.1000.6 Table 12.
const ESI_DATA_TYPE_CODES = {
  BOOL: 1,
  BOOLEAN: 1,
  SINT: 2,
  INT8: 2,
  SINT8: 2,
  INTEGER8: 2,
  INT: 3,
  INT16: 3,
  SINT16: 3,
  INTEGER16: 3,
  DINT: 4,
  INT32: 4,
  SINT32: 4,
  INTEGER32: 4,
  USINT: 5,
  UINT8: 5,
  UNSIGNED8: 5,
  BYTE: 5,
  UINT: 6,
  UINT16: 6,
  UNSIGNED16: 6,
  WORD: 6,
  UDINT: 7,
  UINT32: 7,
  UNSIGNED32: 7,
  DWORD: 7,
  REAL: 8,
  REAL32: 8,
  FLOAT: 8,
  STRING: 9,
  VISIBLE_STRING: 9,
  OCTET_STRING: 10,
  WSTRING: 11,
  UNICODE_STRING: 11,
  TIME_OF_DAY: 12,
  TOD: 12,
  TIME_DIFFERENCE: 13,
  TIME: 13,
  DOMAIN: 14,
  INT24: 15,
  SINT24: 15,
  LREAL: 16,
  REAL64: 16,
  DOUBLE: 16,
  INT40: 17,
  SINT40: 17,
  INT48: 18,
  SINT48: 18,
  INT56: 19,
  SINT56: 19,
  LINT: 20,
  INT64: 20,
  SINT64: 20,
  UINT24: 21,
  USINT24: 21,
  UINT40: 22,
  UINT48: 23,
  UINT56: 24,
  ULINT: 25,
  UINT64: 25,
  BIT1: 26,
  BIT2: 27,
  BIT3: 28,
  BIT4: 29,
  BIT5: 30,
  BIT6: 31,
  BIT7: 32,
  BIT8: 33,
}

const DATA_TYPE_BY_BIT_LENGTH = {
  1: 1,
  8: 5,
  16: 6,
  24: 21,
  32: 7,
  40: 22,
  48: 23,
  56: 24,
  64: 25,
}

// ---------------------------------------------------------------------------
// DOM helpers (DOMParser output; namespace prefixes are ignored)
// ---------------------------------------------------------------------------

function elementName(node) {
  return node.localName || node.nodeName.replace(/^.*:/, '')
}

function children(element, name) {
  const result = []
  if (!element) return result
  for (const node of element.childNodes) {
    if (node.nodeType === 1 && elementName(node) === name) result.push(node)
  }
  return result
}

function child(element, name) {
  return children(element, name)[0] || null
}

function textOf(element) {
  return element ? (element.textContent || '').trim() : ''
}

// SII strings keep the exact ESI text, including trailing spaces such as
// "Actual Torque " in the reference device description.
function rawTextOf(element) {
  return element ? element.textContent || '' : ''
}

function parseNumber(value) {
  const text = String(value ?? '').trim()
  if (!text) return 0
  if (/^#x/i.test(text)) return parseInt(text.slice(2), 16)
  if (/^0x/i.test(text)) return parseInt(text.slice(2), 16)
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : 0
}

function flagAttribute(element, name) {
  return element ? /^(true|1)$/i.test(element.getAttribute(name) || '') : false
}

function localizedName(element) {
  const names = children(element, 'Name')
  if (names.length === 0) return ''
  const preferred = names.find((node) => node.getAttribute('LcId') === '1033')
  return rawTextOf(preferred || names[0])
}

function parseXmlDocument(text) {
  // TwinCAT writes ESI files with a UTF-8 BOM, and a BOM in front of the XML
  // declaration makes DOMParser fail.
  const doc = new DOMParser().parseFromString(text.replace(/^﻿/, ''), 'application/xml')
  const failure = doc.getElementsByTagName('parsererror')[0]
  if (failure) {
    const detail = (failure.textContent || '').trim().split(/\r?\n/)[0]
    throw new Error(`ESI XML 解析失败${detail ? `：${detail}` : ''}`)
  }
  return doc
}

// ---------------------------------------------------------------------------
// Byte and category helpers
// ---------------------------------------------------------------------------

class ByteWriter {
  constructor() {
    this.bytes = []
  }

  u8(value) {
    this.bytes.push(value & 0xff)
  }

  u16(value) {
    this.u8(value)
    this.u8(value >>> 8)
  }

  u32(value) {
    this.u8(value)
    this.u8(value >>> 8)
    this.u8(value >>> 16)
    this.u8(value >>> 24)
  }

  toArray() {
    return this.bytes
  }
}

function writeU16(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
}

function writeU32(bytes, offset, value) {
  bytes[offset] = value & 0xff
  bytes[offset + 1] = (value >>> 8) & 0xff
  bytes[offset + 2] = (value >>> 16) & 0xff
  bytes[offset + 3] = (value >>> 24) & 0xff
}

function padCategoryData(data, fill = 0x00) {
  if (data.length % 2 === 0) return data
  return [...data, fill]
}

function buildCategory(type, data, fill) {
  const padded = padCategoryData(data, fill)
  const category = new Uint8Array(4 + padded.length)
  writeU16(category, 0, type)
  writeU16(category, 2, padded.length / 2)
  category.set(padded, 4)
  return category
}

function parseHexBytes(text, length) {
  const cleaned = String(text || '')
    .replace(/0x/gi, '')
    .replace(/[^0-9a-fA-F]/g, '')
  const bytes = []
  for (let index = 0; index + 1 < cleaned.length; index += 2) {
    bytes.push(parseInt(cleaned.slice(index, index + 2), 16))
  }
  const out = new Uint8Array(length)
  out.set(bytes.slice(0, length))
  return { bytes: out, truncated: bytes.length > length }
}

function toHexString(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join('')
}

function encodeSiiString(value) {
  const bytes = []
  for (const char of value) {
    const code = char.codePointAt(0)
    bytes.push(code <= 0xff ? code : 0x3f)
  }
  return bytes.slice(0, 255)
}

class StringTable {
  constructor() {
    this.entries = []
    this.byText = new Map()
  }

  add(text) {
    const value = String(text ?? '')
    if (!value) return 0
    const existing = this.byText.get(value)
    if (existing) return existing
    if (this.entries.length >= 255) {
      throw new Error('ESI 中的字符串超过 SII 字符串表 255 个的上限')
    }
    const index = this.entries.length + 1
    this.byText.set(value, index)
    this.entries.push(value)
    return index
  }

  encode() {
    const bytes = [this.entries.length]
    for (const value of this.entries) {
      const encoded = encodeSiiString(value)
      bytes.push(encoded.length)
      bytes.push(...encoded)
    }
    return bytes
  }
}

// ---------------------------------------------------------------------------
// ESI -> SII
// ---------------------------------------------------------------------------

function collectBitSizes(device) {
  const sizes = new Map()
  for (const profile of children(device, 'Profile')) {
    const dataTypes = child(child(profile, 'Dictionary'), 'DataTypes')
    for (const dataType of children(dataTypes, 'DataType')) {
      const name = textOf(child(dataType, 'Name')).toUpperCase()
      const bits = parseNumber(textOf(child(dataType, 'BitSize')))
      if (name && bits) sizes.set(name, bits)
    }
  }
  return sizes
}

function resolveDataType(name, bitLength, bitSizes, warnings) {
  const key = String(name || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
  if (key) {
    if (ESI_DATA_TYPE_CODES[key] !== undefined) return ESI_DATA_TYPE_CODES[key]
    const sized = key.match(/^(W?STRING)\(\d+\)$/)
    if (sized) return sized[1] === 'WSTRING' ? 11 : 9
  }

  let bits = bitLength
  if (!bits && key && bitSizes.has(key)) bits = bitSizes.get(key)
  const fallback = DATA_TYPE_BY_BIT_LENGTH[bits]
  if (fallback) {
    if (key) {
      warnings.push({
        level: 'info',
        message: `PDO 条目数据类型 ${name} 不在 SII 类型表中，按位长 ${bits} 映射为 ${DATA_TYPE_NAMES[fallback]}。`,
      })
    }
    return fallback
  }

  warnings.push({
    level: 'warn',
    message: `无法确定 PDO 条目数据类型${name ? ` ${name}` : ''}（位长 ${
      bits || '未知'
    }），SII 类型码写入 0。`,
  })
  return 0
}

// The bootstrap mailbox is not part of an ESI device description; TwinCAT
// derives it from the first two SyncManagers when <BootStrap> is missing.
function deriveBootStrap(syncManagers) {
  const out = new Uint8Array(8)
  if (syncManagers.length >= 2) {
    writeU16(out, 0, syncManagers[0].startAddress)
    writeU16(out, 2, syncManagers[0].length)
    writeU16(out, 4, syncManagers[0].startAddress + syncManagers[0].length)
    writeU16(out, 6, syncManagers[1].length)
  }
  return out
}

// ESI PDO attributes map onto the SII PDO flag word (ETG.1000.6 Table 21,
// the bits listed in PDO_FLAG_BITS): 0x0001 Mandatory, 0x0010 Fixed content,
// 0x0200 Depend on slot.
function pdoFlags(pdoElement, indexElement) {
  return (
    (flagAttribute(pdoElement, 'Mandatory') ? 0x0001 : 0x0000) |
    (flagAttribute(pdoElement, 'Fixed') ? 0x0010 : 0x0000) |
    (flagAttribute(indexElement, 'DependOnSlot') ? 0x0200 : 0x0000)
  )
}

function buildPdoCategory(elements, strings, bitSizes, warnings) {
  const writer = new ByteWriter()
  const bitsBySm = new Map()

  for (const element of elements) {
    const entries = children(element, 'Entry')
    if (entries.length > 255) {
      throw new Error(
        `PDO ${textOf(child(element, 'Index'))} 有 ${entries.length} 个条目，超过 SII 的 255 个上限`,
      )
    }

    const indexElement = child(element, 'Index')
    const index = parseNumber(textOf(indexElement)) & 0xffff
    const smText = element.getAttribute('Sm')
    const syncManager = smText === null || smText.trim() === '' ? 0xff : parseNumber(smText) & 0xff
    const flags = pdoFlags(element, indexElement)

    writer.u16(index)
    writer.u8(entries.length)
    writer.u8(syncManager)
    writer.u8(0) // synchronization: FreeRun
    writer.u8(strings.add(localizedName(element)))
    writer.u16(flags)

    let totalBits = 0
    for (const entry of entries) {
      const entryIndex = child(entry, 'Index')
      const typeName = textOf(child(entry, 'DataType'))
      let bitLength = parseNumber(textOf(child(entry, 'BitLen')))
      if (!bitLength && typeName) {
        const key = typeName.toUpperCase()
        if (bitSizes.has(key)) bitLength = bitSizes.get(key)
      }
      totalBits += bitLength

      writer.u16(parseNumber(textOf(entryIndex)) & 0xffff)
      writer.u8(parseNumber(textOf(child(entry, 'SubIndex'))) & 0xff)
      writer.u8(strings.add(localizedName(entry)))
      writer.u8(resolveDataType(typeName, bitLength, bitSizes, warnings))
      writer.u8(bitLength & 0xff)
      writer.u16(PDO_ENTRY_FLAGS)
    }

    if (syncManager !== 0xff) {
      bitsBySm.set(syncManager, (bitsBySm.get(syncManager) || 0) + totalBits)
    }
  }

  return { data: writer.toArray(), bitsBySm }
}

function buildSyncManagerCategory(smElements, bitsBySm, warnings) {
  const writer = new ByteWriter()
  const entries = []

  smElements.forEach((element, index) => {
    let length = element.hasAttribute('DefaultSize')
      ? parseNumber(element.getAttribute('DefaultSize'))
      : null
    if (length === null) {
      const bits = bitsBySm.get(index)
      if (bits !== undefined) {
        length = Math.ceil(bits / 8)
      } else if (element.hasAttribute('MinSize')) {
        length = parseNumber(element.getAttribute('MinSize'))
        warnings.push({
          level: 'info',
          message: `SyncManager ${index}（${textOf(element) || '未命名'}）没有 DefaultSize，长度取 MinSize ${length} 字节。`,
        })
      } else {
        warnings.push({
          level: 'warn',
          message: `SyncManager ${index}（${textOf(element) || '未命名'}）没有 DefaultSize，也没有可推导的 PDO，长度写入 0。`,
        })
        length = 0
      }
    }

    const entry = {
      index,
      startAddress: parseNumber(element.getAttribute('StartAddress')) & 0xffff,
      length: length & 0xffff,
      control: parseNumber(element.getAttribute('ControlByte')) & 0xff,
      status: 0,
      enable: element.hasAttribute('Enable')
        ? (flagAttribute(element, 'Enable') ? 0x01 : 0x00)
        : 0x01,
      type: (index + 1) & 0xff,
      name: textOf(element),
    }
    entries.push(entry)

    writer.u16(entry.startAddress)
    writer.u16(entry.length)
    writer.u8(entry.control)
    writer.u8(entry.status)
    writer.u8(entry.enable)
    writer.u8(entry.type)
  })

  return { data: writer.toArray(), entries }
}

function buildFmmuCategory(fmmuElements) {
  const data = []
  for (const element of fmmuElements) {
    const name = textOf(element)
    data.push(FMMU_USAGE_BY_NAME[name] ?? 0x00)
  }
  // TwinCAT pads the FMMU list to a whole word with 0xFF.
  return padCategoryData(data, 0xff)
}

function buildDcCategory(opModes) {
  const writer = new ByteWriter()
  for (const opMode of opModes) {
    const cycleTimeSync0 = child(opMode.element, 'CycleTimeSync0')
    const cycleTimeSync1 = child(opMode.element, 'CycleTimeSync1')
    const sync0Factor = parseNumber(cycleTimeSync0?.getAttribute('Factor') ?? '1') || 1

    writer.u32(parseNumber(textOf(cycleTimeSync0)) >>> 0)
    writer.u32(parseNumber(textOf(child(opMode.element, 'ShiftTimeSync0'))) >>> 0)
    writer.u32(parseNumber(textOf(child(opMode.element, 'ShiftTimeSync1'))) >>> 0)
    writer.u16(parseNumber(textOf(cycleTimeSync1)) & 0xffff)
    writer.u16(parseNumber(textOf(child(opMode.element, 'AssignActivate'))) & 0xffff)
    writer.u16(sync0Factor & 0xffff)
    writer.u8(opMode.nameIndex)
    writer.u8(0) // description string index; ESI Desc is not stored in SII
    writer.u32(0)
  }
  return writer.toArray()
}

function buildGeneralCategory(fields) {
  const data = new Array(GENERAL_CATEGORY_BYTES).fill(0)
  data[0] = fields.groupStringIndex & 0xff
  data[1] = 0 // image string index
  data[2] = fields.orderStringIndex & 0xff
  data[3] = fields.nameStringIndex & 0xff
  data[4] = 1 // TwinCAT writes 1 in this reserved byte
  data[5] = fields.coeDetails & 0xff
  data[6] = fields.foeDetails & 0xff
  data[7] = fields.eoeDetails & 0xff
  data[8] = fields.soeChannels & 0xff
  data[9] = fields.ds402Channels & 0xff
  data[10] = fields.sysmanClass & 0xff
  data[11] = fields.flags & 0xff
  writeU16(data, 12, fields.ebusCurrent)
  writeU16(data, 14, fields.physicalMemoryAddress)
  writeU16(data, 16, fields.portsWord)
  return data
}

// ---------------------------------------------------------------------------
// Shared ESI field readers
// ---------------------------------------------------------------------------

function mailboxProtocolBits(mailbox) {
  let bits = 0
  for (const [name, bit] of Object.entries(MAILBOX_PROTOCOL_BITS)) {
    if (child(mailbox, name)) bits |= bit
  }
  return bits
}

function coeDetailBits(coe) {
  if (!coe) return 0
  let details = 0x01 // SDO is always part of a CoE mailbox
  if (flagAttribute(coe, 'SdoInfo')) details |= 0x02
  if (flagAttribute(coe, 'PdoAssign')) details |= 0x04
  if (flagAttribute(coe, 'PdoConfig')) details |= 0x08
  if (flagAttribute(coe, 'PdoUpload')) details |= 0x10
  if (flagAttribute(coe, 'CompleteAccess')) details |= 0x20
  return details
}

function generalFlagBits(device, mailbox) {
  let flags = mailbox ? 0x04 : 0x00
  if (textOf(child(child(device, 'Info'), 'IdentificationReg134')) === 'true') {
    flags |= 0x08
  }
  return flags
}

function physicsToPorts(physics) {
  const ports = [0, 0, 0, 0]
  for (let index = 0; index < Math.min(physics.length, 4); index++) {
    ports[index] = PORT_TYPE_BY_PHYSICS[physics.charAt(index).toUpperCase()] || 0
  }
  return ports
}

function portsToWord(ports) {
  let word = 0
  for (let index = 0; index < Math.min(ports.length, 4); index++) {
    word |= (ports[index] & 0x0f) << (index * 4)
  }
  return word
}

// ---------------------------------------------------------------------------
// ESI -> editable model
//
// `parseEsiXml` normalises one device description into the shape `parseSii`
// returns, so the XML editor page can drive both sources from one form model.
// Fields that only exist in ESI (state machine and mailbox timeouts, profile
// number, SyncManager min/max sizes, CoE SegmentedSdo) are collected under
// `esi`, together with a count of everything an SII image cannot hold at all.
// ---------------------------------------------------------------------------

const STATE_MACHINE_TIMEOUT_FIELDS = [
  ['preopTimeout', 'PreopTimeout'],
  ['safeopOpTimeout', 'SafeopOpTimeout'],
  ['backToInitTimeout', 'BackToInitTimeout'],
  ['backToSafeopTimeout', 'BackToSafeopTimeout'],
]

const MAILBOX_TIMEOUT_FIELDS = [
  ['requestTimeout', 'RequestTimeout'],
  ['responseTimeout', 'ResponseTimeout'],
]

function readTimeouts(element, fields) {
  if (!element) return null
  const timeouts = {}
  let found = false
  for (const [key, tag] of fields) {
    const node = child(element, tag)
    timeouts[key] = parseNumber(textOf(node))
    if (node) found = true
  }
  return found ? timeouts : null
}

function countElements(element, name) {
  let count = 0
  const stack = [element]
  while (stack.length) {
    const node = stack.pop()
    for (const candidate of node.childNodes) {
      if (candidate.nodeType !== 1) continue
      if (elementName(candidate) === name) count += 1
      stack.push(candidate)
    }
  }
  return count
}

function readEsiPdo(element, bitSizes, warnings) {
  const indexElement = child(element, 'Index')
  const smText = element.getAttribute('Sm')
  const entries = children(element, 'Entry').map((entry) => {
    const typeName = textOf(child(entry, 'DataType'))
    let bitLength = parseNumber(textOf(child(entry, 'BitLen')))
    if (!bitLength && typeName) {
      const key = typeName.toUpperCase()
      if (bitSizes.has(key)) bitLength = bitSizes.get(key)
    }
    return {
      index: parseNumber(textOf(child(entry, 'Index'))) & 0xffff,
      subIndex: parseNumber(textOf(child(entry, 'SubIndex'))) & 0xff,
      bitLength,
      // ESI names can carry significant trailing spaces ("Actual Torque "),
      // so they are copied verbatim.
      name: rawTextOf(child(entry, 'Name')),
      dataType: resolveDataType(typeName, bitLength, bitSizes, warnings),
      dataTypeName: typeName,
    }
  })

  return {
    index: parseNumber(textOf(indexElement)) & 0xffff,
    syncManager: smText === null || smText.trim() === '' ? 0xff : parseNumber(smText) & 0xff,
    flags: pdoFlags(element, indexElement),
    name: rawTextOf(child(element, 'Name')),
    entries,
    totalBits: entries.reduce((sum, entry) => sum + entry.bitLength, 0),
  }
}

function readEsiDc(device) {
  const opModes = children(child(device, 'Dc'), 'OpMode')
  return {
    elements: opModes.map((element, index) => {
      const cycleTimeSync0 = child(element, 'CycleTimeSync0')
      const cycleTimeSync1 = child(element, 'CycleTimeSync1')
      return {
        index,
        name: rawTextOf(child(element, 'Name')),
        description: rawTextOf(child(element, 'Desc')),
        assignActivate: parseNumber(textOf(child(element, 'AssignActivate'))),
        sync0CycleTime: parseNumber(textOf(cycleTimeSync0)),
        sync0ShiftTime: parseNumber(textOf(child(element, 'ShiftTimeSync0'))),
        sync1ShiftTime: parseNumber(textOf(child(element, 'ShiftTimeSync1'))),
        sync1CycleFactor: parseNumber(textOf(cycleTimeSync1)),
        sync0CycleFactor: parseNumber(cycleTimeSync0?.getAttribute('Factor') ?? '1') || 1,
      }
    }),
  }
}

export function parseEsiXml(xmlText, options = {}) {
  const doc = typeof xmlText === 'string' ? parseXmlDocument(xmlText) : xmlText
  const root = doc.documentElement
  if (!root || elementName(root) !== 'EtherCATInfo') {
    throw new Error('不是 EtherCATInfo ESI 文件（根元素不是 <EtherCATInfo>）')
  }

  const warnings = []
  const vendorElement = child(root, 'Vendor')
  const vendorId = parseNumber(textOf(child(vendorElement, 'Id')))
  if (!vendorId) {
    warnings.push({ level: 'warn', message: 'ESI 缺少有效的 <Vendor><Id>，厂商 ID 为 0。' })
  }

  const descriptions = child(root, 'Descriptions')
  const deviceElements = children(child(descriptions, 'Devices'), 'Device')
  if (deviceElements.length === 0) {
    throw new Error('ESI 中没有找到 <Descriptions><Devices><Device>')
  }

  const requested = Math.trunc(Number(options.deviceIndex ?? 0)) || 0
  const deviceIndex = Math.min(Math.max(requested, 0), deviceElements.length - 1)
  if (deviceIndex !== requested) {
    warnings.push({
      level: 'warn',
      message: `设备序号 ${options.deviceIndex} 超出 1..${deviceElements.length} 的范围，已改用第 ${deviceIndex + 1} 个设备。`,
    })
  }
  const device = deviceElements[deviceIndex]

  const typeElement = child(device, 'Type')
  const info = child(device, 'Info')
  const mailbox = child(device, 'Mailbox')
  const coe = child(mailbox, 'CoE')
  const eeprom = child(device, 'Eeprom')

  const physics = (device.getAttribute('Physics') || '').trim()
  const ports = physicsToPorts(physics)

  const orderName = rawTextOf(typeElement)
  const deviceName = localizedName(device)
  let groupName = rawTextOf(child(device, 'GroupType'))
  if (!groupName) {
    const firstGroup = child(child(descriptions, 'Groups'), 'Group')
    groupName = rawTextOf(child(firstGroup, 'Type')) || rawTextOf(child(firstGroup, 'Name'))
  }

  const byteSize = parseNumber(textOf(child(eeprom, 'ByteSize'))) || 2048
  const configDataText = textOf(child(eeprom, 'ConfigData'))
  const bootStrapText = textOf(child(eeprom, 'BootStrap'))
  const configData = configDataText
    ? toHexString(parseHexBytes(configDataText, 10).bytes)
    : ''

  const bitSizes = collectBitSizes(device)
  const syncManagers = children(device, 'Sm').map((element, index) => {
    const minSize = element.hasAttribute('MinSize') ? parseNumber(element.getAttribute('MinSize')) : null
    const maxSize = element.hasAttribute('MaxSize') ? parseNumber(element.getAttribute('MaxSize')) : null
    const defaultSize = element.hasAttribute('DefaultSize')
      ? parseNumber(element.getAttribute('DefaultSize'))
      : null
    return {
      index,
      startAddress: parseNumber(element.getAttribute('StartAddress')) & 0xffff,
      length: (defaultSize ?? minSize ?? 0) & 0xffff,
      control: parseNumber(element.getAttribute('ControlByte')) & 0xff,
      enable: element.hasAttribute('Enable') ? (flagAttribute(element, 'Enable') ? 0x01 : 0x00) : 0x01,
      minSize,
      maxSize,
      name: textOf(element),
    }
  })

  const syncManagerSizes = {}
  for (const manager of syncManagers) {
    if (manager.minSize === null && manager.maxSize === null) continue
    syncManagerSizes[manager.index] = { minSize: manager.minSize, maxSize: manager.maxSize }
  }

  // Keep the image reproducible: an ESI without <BootStrap> gets the same
  // SyncManager-derived value the SII compiler would use.
  const bootStrap = bootStrapText
    ? toHexString(parseHexBytes(bootStrapText, 8).bytes)
    : toHexString(deriveBootStrap(syncManagers))

  const fmmus = children(device, 'Fmmu').map((element) => {
    const label = textOf(element)
    return { usage: FMMU_USAGE_BY_NAME[label] ?? 0x00, label }
  })

  const profileNo = parseNumber(textOf(child(child(device, 'Profile'), 'ProfileNo'))) || null

  const dropped = {
    objects: countElements(root, 'Object'),
    initCommands: countElements(root, 'InitCmd'),
    images: countElements(root, 'ImageData16x14'),
    slots: countElements(root, 'Slot'),
    modules: countElements(root, 'Module'),
    excludes: countElements(root, 'Exclude'),
  }

  if (dropped.objects) {
    warnings.push({
      level: 'info',
      message: `ESI 中的 ${dropped.objects} 个对象字典条目（Profile/Dictionary）无法写入 SII，重新生成时会被丢弃。`,
    })
  }
  if (dropped.initCommands) {
    warnings.push({
      level: 'info',
      message: `ESI 中的 ${dropped.initCommands} 条 InitCmd（启动命令）无法写入 SII，重新生成时会被丢弃。`,
    })
  }
  if (dropped.images) {
    warnings.push({
      level: 'info',
      message: `ESI 中的 ${dropped.images} 张 ImageData16x14 图像无法写入 SII，重新生成时会被丢弃。`,
    })
  }
  if (dropped.slots || dropped.modules) {
    warnings.push({
      level: 'info',
      message: `ESI 中的槽位定义（${dropped.slots} 个 Slot / ${dropped.modules} 个 Module）无法写入 SII，重新生成时会被丢弃。`,
    })
  }
  if (dropped.excludes) {
    warnings.push({
      level: 'info',
      message: `ESI 中的 ${dropped.excludes} 条 PDO Exclude（互斥分配）无法写入 SII，重新生成时会被丢弃。`,
    })
  }

  return {
    source: 'esi',
    // No SII image behind an imported ESI: the editor compiles one on demand.
    bytes: new Uint8Array(0),
    byteLength: 0,
    info: {
      vendorId,
      productCode: parseNumber(typeElement?.getAttribute('ProductCode')),
      revisionNumber: parseNumber(typeElement?.getAttribute('RevisionNo')),
      serialNumber: 0,
      eepromSizeBytes: byteSize,
      eepromSizeRaw: byteSize / 128 - 1,
      mailboxProtocols: mailboxProtocolBits(mailbox),
    },
    general: {
      groupStringIndex: 0,
      imageStringIndex: 0,
      orderStringIndex: 0,
      nameStringIndex: 0,
      coeDetails: coeDetailBits(coe),
      foeDetails: child(mailbox, 'FoE') ? 0x01 : 0x00,
      eoeDetails: child(mailbox, 'EoE') ? 0x01 : 0x00,
      flags: generalFlagBits(device, mailbox),
      ebusCurrent: parseNumber(textOf(child(device, 'EbusCurrent'))),
      portsWord: portsToWord(ports),
      ports,
      physicalMemoryAddress: 0x0002,
      groupName,
      orderName,
      deviceName,
    },
    strings: [],
    fmmus,
    syncManagers,
    txPdos: children(device, 'TxPdo').map((element) => readEsiPdo(element, bitSizes, warnings)),
    rxPdos: children(device, 'RxPdo').map((element) => readEsiPdo(element, bitSizes, warnings)),
    dc: readEsiDc(device),
    categories: [],
    esi: {
      vendorName: textOf(child(vendorElement, 'Name')),
      deviceIndex,
      deviceCount: deviceElements.length,
      devices: deviceElements.map((element, index) => ({
        index,
        orderName: textOf(child(element, 'Type')) || localizedName(element),
      })),
      physics,
      stateMachineTimeouts: readTimeouts(child(child(info, 'StateMachine'), 'Timeout'), STATE_MACHINE_TIMEOUT_FIELDS),
      mailboxTimeouts: readTimeouts(child(child(info, 'Mailbox'), 'Timeout'), MAILBOX_TIMEOUT_FIELDS),
      profileNo,
      coeSegmentedSdo: flagAttribute(coe, 'SegmentedSdo'),
      syncManagerSizes,
      configData,
      bootStrap,
      dropped,
    },
    warnings,
  }
}

export function generateSiiFromEsi(xmlText, options = {}) {
  const doc = typeof xmlText === 'string' ? parseXmlDocument(xmlText) : xmlText
  const root = doc.documentElement
  if (!root || elementName(root) !== 'EtherCATInfo') {
    throw new Error('不是 EtherCATInfo ESI 文件（根元素不是 <EtherCATInfo>）')
  }

  const warnings = []
  const vendor = child(root, 'Vendor')
  const vendorId = parseNumber(textOf(child(vendor, 'Id')))
  if (!vendorId) {
    warnings.push({ level: 'warn', message: 'ESI 缺少有效的 <Vendor><Id>，厂商 ID 写入 0。' })
  }

  const devicesElement = child(child(root, 'Descriptions'), 'Devices')
  const deviceElements = children(devicesElement, 'Device')
  if (deviceElements.length === 0) {
    throw new Error('ESI 中没有找到 <Descriptions><Devices><Device>')
  }
  const requested = Math.trunc(Number(options.deviceIndex ?? 0)) || 0
  const deviceIndex = Math.min(Math.max(requested, 0), deviceElements.length - 1)
  if (deviceElements.length > 1) {
    warnings.push({
      level: 'info',
      message: `ESI 包含 ${deviceElements.length} 个设备描述，本次生成第 ${deviceIndex + 1} 个。`,
    })
  }
  const device = deviceElements[deviceIndex]

  const typeElement = child(device, 'Type')
  const productCode = parseNumber(typeElement?.getAttribute('ProductCode'))
  const revisionNumber = parseNumber(typeElement?.getAttribute('RevisionNo'))
  const orderName = rawTextOf(typeElement)
  const deviceName = localizedName(device)
  let groupName = rawTextOf(child(device, 'GroupType'))
  if (!groupName) {
    const firstGroup = child(child(child(root, 'Descriptions'), 'Groups'), 'Group')
    groupName = rawTextOf(child(firstGroup, 'Type')) || rawTextOf(child(firstGroup, 'Name'))
  }

  const strings = new StringTable()
  const orderStringIndex = strings.add(orderName)
  const groupStringIndex = strings.add(groupName)
  const nameStringIndex = strings.add(deviceName)

  const opModeElements = children(child(device, 'Dc'), 'OpMode')
  const opModes = opModeElements.map((element) => ({
    element,
    nameIndex: strings.add(localizedName(element)),
  }))

  const bitSizes = collectBitSizes(device)
  const txPdos = children(device, 'TxPdo')
  const rxPdos = children(device, 'RxPdo')
  // String indices are allocated in TwinCAT's order: TxPDO before RxPDO.
  const tx = buildPdoCategory(txPdos, strings, bitSizes, warnings)
  const rx = buildPdoCategory(rxPdos, strings, bitSizes, warnings)

  const smElements = children(device, 'Sm')
  const bitsBySm = new Map()
  for (const [key, value] of tx.bitsBySm) bitsBySm.set(key, (bitsBySm.get(key) || 0) + value)
  for (const [key, value] of rx.bitsBySm) bitsBySm.set(key, (bitsBySm.get(key) || 0) + value)
  const sm = buildSyncManagerCategory(smElements, bitsBySm, warnings)

  const mailbox = child(device, 'Mailbox')
  const coe = child(mailbox, 'CoE')
  const mailboxProtocols = mailboxProtocolBits(mailbox)
  const coeDetails = coeDetailBits(coe)
  if (flagAttribute(coe, 'SegmentedSdo')) {
    warnings.push({
      level: 'info',
      message: 'CoE 的 SegmentedSdo 属性只存在于 ESI 中，SII 的 CoE Details 字节没有对应位，已忽略。',
    })
  }

  const generalFlags = generalFlagBits(device, mailbox)

  const physics = (device.getAttribute('Physics') || '').trim()
  const portsWord = portsToWord(physicsToPorts(physics))

  const eeprom = child(device, 'Eeprom')
  const declaredSize = parseNumber(textOf(child(eeprom, 'ByteSize')))
  const byteSize = declaredSize || 2048
  if (byteSize % 128 !== 0) {
    throw new Error(`EEPROM 大小 ${byteSize} 字节不是 128 的整数倍`)
  }
  if (byteSize > MAX_INPUT_BYTES) {
    throw new Error(`EEPROM 大小 ${byteSize} 字节超过 ${MAX_INPUT_BYTES / 1024} KiB 上限`)
  }
  if (!declaredSize) {
    warnings.push({
      level: 'info',
      message: 'ESI 没有 <Eeprom><ByteSize>，按 2048 字节生成。',
    })
  }

  const configData = parseHexBytes(textOf(child(eeprom, 'ConfigData')), 10)
  if (configData.truncated) {
    warnings.push({ level: 'warn', message: 'ConfigData 超过 10 字节，已截断。' })
  }
  if (!textOf(child(eeprom, 'ConfigData'))) {
    warnings.push({
      level: 'warn',
      message: 'ESI 没有 <Eeprom><ConfigData>，固定头前 10 字节写入 0（PDI Control 为 0）。',
    })
  }

  let bootStrap
  const bootStrapText = textOf(child(eeprom, 'BootStrap'))
  if (bootStrapText) {
    bootStrap = parseHexBytes(bootStrapText, 8).bytes
  } else {
    bootStrap = deriveBootStrap(sm.entries)
    warnings.push({
      level: 'info',
      message: 'ESI 没有 <Eeprom><BootStrap>，已按 SyncManager 0/1 推导 Bootstrap 邮箱。',
    })
  }

  const header = new Uint8Array(HEADER_BYTES)
  header.set(configData.bytes, 0)
  header[0x0e] = crc8Sii(header, 14)
  writeU32(header, 0x10, vendorId)
  writeU32(header, 0x14, productCode)
  writeU32(header, 0x18, revisionNumber)
  writeU32(header, 0x1c, 0)
  header.set(bootStrap, 0x28)
  if (sm.entries.length >= 2) {
    writeU16(header, 0x30, sm.entries[0].startAddress)
    writeU16(header, 0x32, sm.entries[0].length)
    writeU16(header, 0x34, sm.entries[1].startAddress)
    writeU16(header, 0x36, sm.entries[1].length)
  }
  writeU16(header, 0x38, mailboxProtocols)
  // TwinCAT marks the reserved words 0x20-0x22 with 0xFFFF.
  writeU16(header, 0x40, 0xffff)
  writeU16(header, 0x42, 0xffff)
  writeU16(header, 0x44, 0xffff)
  writeU16(header, 0x7c, byteSize / 128 - 1)
  writeU16(header, 0x7e, 1)

  const generalData = buildGeneralCategory({
    groupStringIndex,
    orderStringIndex,
    nameStringIndex,
    coeDetails,
    foeDetails: child(mailbox, 'FoE') ? 0x01 : 0x00,
    eoeDetails: child(mailbox, 'EoE') ? 0x01 : 0x00,
    soeChannels: 0,
    ds402Channels: 0,
    sysmanClass: 0,
    flags: generalFlags,
    ebusCurrent: parseNumber(textOf(child(device, 'EbusCurrent'))) & 0xffff,
    portsWord,
    // The physical-memory-address word is not derived from the ESI. TwinCAT
    // writes 0x0002 in the reference image; the field is unused unless the
    // "identification via physical memory" flag is set.
    physicalMemoryAddress: 0x0002,
  })

  const categories = []
  const addCategory = (type, data, fill) => {
    categories.push({
      type,
      name: categoryName(type),
      data,
      bytes: buildCategory(type, data, fill),
    })
  }

  addCategory(CATEGORY_TYPE.STRINGS, strings.encode())
  addCategory(CATEGORY_TYPE.GENERAL, generalData)
  if (smElements.length > 0) addCategory(CATEGORY_TYPE.SYNC_MANAGER, sm.data)
  if (txPdos.length > 0) addCategory(CATEGORY_TYPE.TX_PDO, tx.data)
  if (rxPdos.length > 0) addCategory(CATEGORY_TYPE.RX_PDO, rx.data)
  if (opModes.length > 0) addCategory(CATEGORY_TYPE.DC, buildDcCategory(opModes))
  if (child(device, 'Fmmu')) addCategory(CATEGORY_TYPE.FMMU, buildFmmuCategory(children(device, 'Fmmu')), 0xff)

  // TwinCAT emits FMMU before SyncManager; keep the canonical order.
  const orderedCategories = [
    CATEGORY_TYPE.STRINGS,
    CATEGORY_TYPE.GENERAL,
    CATEGORY_TYPE.FMMU,
    CATEGORY_TYPE.SYNC_MANAGER,
    CATEGORY_TYPE.TX_PDO,
    CATEGORY_TYPE.RX_PDO,
    CATEGORY_TYPE.DC,
  ].map((type) => categories.find((category) => category.type === type))

  const used = orderedCategories.filter(Boolean)
  const required = HEADER_BYTES + used.reduce((sum, category) => sum + category.bytes.length, 0) + 4
  if (required > byteSize) {
    throw new Error(
      `生成的类别数据需要 ${required} 字节，超过 ESI 声明的 EEPROM 大小 ${byteSize} 字节`,
    )
  }

  const bytes = new Uint8Array(byteSize).fill(0xff)
  bytes.set(header, 0)
  let offset = HEADER_BYTES
  for (const category of used) {
    bytes.set(category.bytes, offset)
    offset += category.bytes.length
  }
  writeU16(bytes, offset, CATEGORY_TYPE.END)
  writeU16(bytes, offset + 2, 0xffff)

  return {
    bytes,
    warnings,
    summary: {
      vendorId,
      productCode,
      revisionNumber,
      orderName,
      deviceName,
      groupName,
      byteSize,
      stringCount: strings.entries.length,
      syncManagerCount: sm.entries.length,
      txPdoCount: txPdos.length,
      rxPdoCount: rxPdos.length,
      dcCount: opModes.length,
      mailboxProtocols,
      coeDetails,
      configData: toHexString(configData.bytes),
      bootStrap: toHexString(bootStrap),
      categories: used.map((category) => ({
        type: category.type,
        name: category.name,
        sizeBytes: category.bytes.length - 4,
        sizeWords: (category.bytes.length - 4) / 2,
      })),
    },
  }
}

// ---------------------------------------------------------------------------
// SII -> ESI XML
// ---------------------------------------------------------------------------

function escapeXml(value) {
  return String(value ?? '')
    // XML 1.0 forbids most C0 control characters; SII strings can carry them
    // after Latin-1 decoding (for example NUL padding).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function hexValue(value) {
  return `#x${Number(value).toString(16)}`
}

function hexId(value) {
  return `#x${Number(value).toString(16).padStart(8, '0')}`
}

function physicsForPorts(ports) {
  if (!ports) return ''
  const letters = []
  for (const type of ports) {
    if (!type) break
    letters.push(PORT_PHYSICS_BY_TYPE[type] || '')
  }
  return letters.join('')
}

function hexRange(bytes, start, length) {
  const out = new Uint8Array(length)
  if (bytes && bytes.length) {
    out.set(bytes.subarray(start, Math.min(start + length, bytes.length)))
  }
  return toHexString(out)
}

function optionValue(options, key, fallback) {
  const value = options[key]
  return value === undefined || value === null ? fallback : value
}

function boolOption(options, key, fallback) {
  const value = options[key]
  return value === undefined || value === null ? fallback : Boolean(value)
}

// Builds an EtherCATInfo document from a parsed SII image. Every field can be
// overridden through `options`, which is what the ESI XML generator page uses
// to edit a device before exporting it.
export function generateEsiXml(result, options = {}) {
  if (!result || !result.info) throw new Error('没有可导出的解析结果')

  const warnings = []
  const { info, general, fmmus, syncManagers, txPdos, rxPdos, dc } = result
  // Fields that only live in ESI come from `result.esi` when the source was an
  // imported ESI document, and stay absent for an SII dump.
  const esi = result.esi || {}
  const deviceName = optionValue(options, 'deviceName', general?.deviceName || '')
  const orderName = optionValue(options, 'orderName', general?.orderName || deviceName || 'Device')
  const groupName = optionValue(options, 'groupName', general?.groupName || 'Group')
  const vendorName = optionValue(options, 'vendorName', esi.vendorName || 'Vendor (SII image)')
  const vendorId = optionValue(options, 'vendorId', info.vendorId ?? 0)
  const productCode = optionValue(options, 'productCode', info.productCode ?? 0)
  const revisionNumber = optionValue(options, 'revisionNumber', info.revisionNumber ?? 0)
  const byteSize = optionValue(
    options,
    'byteSize',
    info.eepromSizeBytes || result.byteLength || 2048,
  )
  const mailboxProtocols = optionValue(options, 'mailboxProtocols', info.mailboxProtocols ?? 0)
  const coeDetails = optionValue(options, 'coeDetails', general?.coeDetails ?? 0)
  const identificationReg134 = boolOption(
    options,
    'identificationReg134',
    Boolean(general?.flags & 0x08),
  )
  const physics = optionValue(options, 'physics', physicsForPorts(general?.ports))
  const includeMailbox = boolOption(options, 'includeMailbox', true)
  const includeFmmu = boolOption(options, 'includeFmmu', true)
  const includeSyncManagers = boolOption(options, 'includeSyncManagers', true)
  const includePdos = boolOption(options, 'includePdos', true)
  const includeDc = boolOption(options, 'includeDc', true)
  const stateMachineTimeouts = optionValue(options, 'stateMachineTimeouts', esi.stateMachineTimeouts || null)
  const mailboxTimeouts = optionValue(options, 'mailboxTimeouts', esi.mailboxTimeouts || null)
  const profileNo = optionValue(options, 'profileNo', esi.profileNo ?? null)
  const coeSegmentedSdo = boolOption(options, 'coeSegmentedSdo', Boolean(esi.coeSegmentedSdo))
  const syncManagerSizes = optionValue(options, 'syncManagerSizes', esi.syncManagerSizes || null)
  const configData = optionValue(options, 'configData', esi.configData || hexRange(result.bytes, 0, 10))
  const bootStrap = optionValue(options, 'bootStrap', esi.bootStrap || hexRange(result.bytes, 0x28, 8))

  const lines = []
  const push = (depth, text) => lines.push(`${'\t'.repeat(depth)}${text}`)

  push(0, '<?xml version="1.0" encoding="utf-8"?>')
  push(0, '<EtherCATInfo Version="1.6">')
  push(1, '<Vendor>')
  push(2, `<Id>${hexId(vendorId)}</Id>`)
  push(2, `<Name>${escapeXml(vendorName)}</Name>`)
  push(1, '</Vendor>')
  push(1, '<Descriptions>')
  push(2, '<Groups>')
  push(3, '<Group SortOrder="1">')
  push(4, `<Type>${escapeXml(groupName)}</Type>`)
  push(4, `<Name LcId="1033">${escapeXml(groupName)}</Name>`)
  push(3, '</Group>')
  push(2, '</Groups>')
  push(2, '<Devices>')

  push(3, `<Device Physics="${escapeXml(physics)}">`)
  push(
    4,
    `<Type ProductCode="${productCode}" RevisionNo="${revisionNumber}">${escapeXml(orderName)}</Type>`,
  )
  push(4, `<Name LcId="1033">${escapeXml(deviceName || orderName)}</Name>`)

  const writeTimeoutGroup = (tag, timeouts, fields) => {
    push(5, `<${tag}>`)
    push(6, '<Timeout>')
    for (const [key, field] of fields) {
      push(7, `<${field}>${Number(timeouts[key] ?? 0)}</${field}>`)
    }
    push(6, '</Timeout>')
    push(5, `</${tag}>`)
  }

  if (identificationReg134 || stateMachineTimeouts || mailboxTimeouts) {
    push(4, '<Info>')
    if (stateMachineTimeouts) {
      writeTimeoutGroup('StateMachine', stateMachineTimeouts, STATE_MACHINE_TIMEOUT_FIELDS)
    }
    if (mailboxTimeouts) writeTimeoutGroup('Mailbox', mailboxTimeouts, MAILBOX_TIMEOUT_FIELDS)
    if (identificationReg134) push(5, '<IdentificationReg134>true</IdentificationReg134>')
    push(4, '</Info>')
  }
  push(4, `<GroupType>${escapeXml(groupName)}</GroupType>`)
  if (profileNo) {
    push(4, '<Profile>')
    push(5, `<ProfileNo>${Number(profileNo)}</ProfileNo>`)
    push(4, '</Profile>')
  }

  const fmmuUsages = (fmmus || []).map((entry) => entry.usage)
  while (fmmuUsages.length && fmmuUsages[fmmuUsages.length - 1] === 0xff) fmmuUsages.pop()
  if (includeFmmu) {
    for (const usage of fmmuUsages) {
      if (FMMU_NAME_BY_USAGE[usage] === undefined) {
        warnings.push({
          level: 'warn',
          message: `FMMU 用途 0x${usage.toString(16).toUpperCase()} 不是标准值，导出为 Out。`,
        })
      }
      push(4, `<Fmmu>${escapeXml(FMMU_NAME_BY_USAGE[usage] ?? 'Out')}</Fmmu>`)
    }
  } else if (fmmuUsages.length) {
    warnings.push({ level: 'info', message: `已按设置省略 ${fmmuUsages.length} 个 FMMU 条目。` })
  }

  const smNames = ['MBoxOut', 'MBoxIn', 'Outputs', 'Inputs']
  if (includeSyncManagers) {
    for (const manager of syncManagers || []) {
      const name = smNames[manager.index] || `SM${manager.index}`
      const sizes = syncManagerSizes?.[manager.index] || null
      // TwinCAT writes 34/256 for the two mailbox SyncManagers; an imported ESI
      // keeps whatever MinSize/MaxSize it declared.
      const minSize = sizes?.minSize ?? (manager.index < 2 ? 34 : null)
      const maxSize = sizes?.maxSize ?? (manager.index < 2 ? 256 : null)
      const attributes = []
      if (minSize !== null && minSize !== undefined) attributes.push(`MinSize="${minSize}"`)
      if (maxSize !== null && maxSize !== undefined) attributes.push(`MaxSize="${maxSize}"`)
      if (manager.enable > 1) {
        warnings.push({
          level: 'warn',
          message: `SyncManager ${manager.index} 的 Enable 字节为 0x${manager.enable
            .toString(16)
            .toUpperCase()}，ESI 只能表达启用/禁用，导出为启用。`,
        })
      }
      attributes.push(
        `DefaultSize="${manager.length}"`,
        `StartAddress="${hexValue(manager.startAddress)}"`,
        `ControlByte="${hexValue(manager.control)}"`,
        `Enable="${manager.enable ? '1' : '0'}"`,
      )
      push(4, `<Sm ${attributes.join(' ')}>${name}</Sm>`)
    }
  } else if ((syncManagers || []).length) {
    warnings.push({
      level: 'info',
      message: `已按设置省略 ${syncManagers.length} 个 SyncManager 条目。`,
    })
  }

  const writePdo = (tag, pdo) => {
    const attributes = [`Fixed="${pdo.flags & 0x0010 ? '1' : '0'}"`]
    if (pdo.flags & 0x0001) attributes.push('Mandatory="true"')
    if (pdo.syncManager !== 0xff) attributes.push(`Sm="${pdo.syncManager}"`)
    push(4, `<${tag} ${attributes.join(' ')}>`)
    push(
      5,
      `<Index${pdo.flags & 0x0200 ? ' DependOnSlot="true"' : ''}>${hexValue(pdo.index)}</Index>`,
    )
    const pdoName = pdo.name || `PDO 0x${pdo.index.toString(16).toUpperCase()}`
    if (!pdo.name) {
      warnings.push({
        level: 'warn',
        message: `PDO 0x${pdo.index
          .toString(16)
          .toUpperCase()} 没有名称，ESI 要求 <Name>，已写入占位名称 ${pdoName}。`,
      })
    }
    push(5, `<Name>${escapeXml(pdoName)}</Name>`)
    for (const entry of pdo.entries) {
      // Entries read from an ESI keep their original type name; entries read
      // from an SII image are named after their SII data type code.
      const typeName = entry.dataTypeName || DATA_TYPE_NAMES[entry.dataType]
      if (!typeName) {
        warnings.push({
          level: 'warn',
          message: `PDO 0x${pdo.index
            .toString(16)
            .toUpperCase()} 的条目 0x${entry.index
            .toString(16)
            .toUpperCase()} 使用未知 SII 数据类型码 ${entry.dataType}，导出为 OCTET_STRING，重新生成时会变化。`,
        })
      }
      push(5, '<Entry>')
      push(6, `<Index>${hexValue(entry.index)}</Index>`)
      push(6, `<SubIndex>${entry.subIndex}</SubIndex>`)
      push(6, `<BitLen>${entry.bitLength}</BitLen>`)
      if (entry.name) push(6, `<Name>${escapeXml(entry.name)}</Name>`)
      push(6, `<DataType>${escapeXml(typeName || 'OCTET_STRING')}</DataType>`)
      push(5, '</Entry>')
    }
    push(4, `</${tag}>`)
  }

  if (includePdos) {
    for (const pdo of rxPdos || []) writePdo('RxPdo', pdo)
    for (const pdo of txPdos || []) writePdo('TxPdo', pdo)
  } else if ((rxPdos || []).length + (txPdos || []).length) {
    warnings.push({
      level: 'info',
      message: `已按设置省略 ${(rxPdos || []).length + (txPdos || []).length} 个 PDO。`,
    })
  }

  const sourceHasMailbox = mailboxProtocols !== 0 || Boolean(general?.flags & 0x04)
  if (includeMailbox) {
    push(4, '<Mailbox DataLinkLayer="true">')
    // Mailbox protocol elements follow the ETG.2000 sequence.
    if (mailboxProtocols & 0x01) push(5, '<AoE />')
    if (mailboxProtocols & 0x02) push(5, '<EoE />')
    if (mailboxProtocols & 0x04) {
      const attributes = [`SdoInfo="${coeDetails & 0x02 ? 'true' : 'false'}"`]
      if (coeSegmentedSdo) attributes.push('SegmentedSdo="true"')
      attributes.push(
        `PdoAssign="${coeDetails & 0x04 ? 'true' : 'false'}"`,
        `PdoConfig="${coeDetails & 0x08 ? 'true' : 'false'}"`,
        `PdoUpload="${coeDetails & 0x10 ? 'true' : 'false'}"`,
        `CompleteAccess="${coeDetails & 0x20 ? 'true' : 'false'}"`,
      )
      push(5, `<CoE ${attributes.join(' ')} />`)
    }
    if (mailboxProtocols & 0x08) push(5, '<FoE />')
    if (mailboxProtocols & 0x10) push(5, '<SoE />')
    if (mailboxProtocols & 0x20) push(5, '<VoE />')
    push(4, '</Mailbox>')
  } else if (sourceHasMailbox) {
    warnings.push({ level: 'info', message: '已按设置省略 Mailbox 元素。' })
  }

  if (includeDc && dc?.elements?.length) {
    push(4, '<Dc>')
    for (const element of dc.elements) {
      push(5, '<OpMode>')
      push(6, `<Name>${escapeXml(element.name || `OpMode ${element.index}`)}</Name>`)
      if (element.description) push(6, `<Desc>${escapeXml(element.description)}</Desc>`)
      push(6, `<AssignActivate>${hexValue(element.assignActivate)}</AssignActivate>`)
      push(
        6,
        `<CycleTimeSync0 Factor="${element.sync0CycleFactor ?? 1}">${element.sync0CycleTime ?? 0}</CycleTimeSync0>`,
      )
      push(6, `<ShiftTimeSync0>${element.sync0ShiftTime ?? 0}</ShiftTimeSync0>`)
      push(6, `<CycleTimeSync1 Factor="1">${element.sync1CycleFactor ?? 0}</CycleTimeSync1>`)
      push(6, `<ShiftTimeSync1>${element.sync1ShiftTime ?? 0}</ShiftTimeSync1>`)
      push(5, '</OpMode>')
    }
    push(4, '</Dc>')
  } else if (!includeDc && dc?.elements?.length) {
    warnings.push({
      level: 'info',
      message: `已按设置省略 ${dc.elements.length} 个 DC 操作模式。`,
    })
  }

  push(4, '<Eeprom>')
  push(5, `<ByteSize>${byteSize}</ByteSize>`)
  push(5, `<ConfigData>${configData}</ConfigData>`)
  push(5, `<BootStrap>${bootStrap}</BootStrap>`)
  push(4, '</Eeprom>')
  push(3, '</Device>')
  push(2, '</Devices>')
  push(1, '</Descriptions>')
  push(0, '</EtherCATInfo>')

  if (info.serialNumber) {
    warnings.push({
      level: 'info',
      message: `序列号 0x${info.serialNumber.toString(16).toUpperCase()} 无法写入 ESI，重新生成时为 0。`,
    })
  }
  if (general?.imageStringIndex) {
    warnings.push({ level: 'info', message: 'SII 中的图像字符串无法从 ESI 重新生成。' })
  }
  if (general?.ds402Channels) {
    warnings.push({
      level: 'info',
      message: `DS402 通道数 ${general.ds402Channels} 无法在 ESI 中表达，重新生成时为 0。`,
    })
  }
  const portTypes = general?.ports || []
  const firstUnusedPort = portTypes.findIndex((type) => !type)
  if (
    options.physics === undefined &&
    firstUnusedPort !== -1 &&
    portTypes.slice(firstUnusedPort).some((type) => type)
  ) {
    warnings.push({
      level: 'info',
      message: 'SII 端口类型在未使用端口之后仍有定义，ESI 的 Physics 属性无法表达这种间隔。',
    })
  }
  if (general && general.physicalMemoryAddress !== null && general.physicalMemoryAddress !== 0x0002) {
    warnings.push({
      level: 'info',
      message: `General 类别的物理内存地址 0x${Number(general.physicalMemoryAddress ?? 0)
        .toString(16)
        .toUpperCase()} 无法写入 ESI，重新生成时为 0x0002。`,
    })
  }
  if ((general?.flags ?? 0) & 0x01) {
    warnings.push({ level: 'info', message: 'General 标志位“Enable SafeOp”无法在 ESI 中表达。' })
  }
  if ((general?.flags ?? 0) & 0x10) {
    warnings.push({ level: 'info', message: 'General 标志位“Physical Memory 识别”无法在 ESI 中表达。' })
  }
  if (
    options.byteSize === undefined &&
    (info.eepromSizeRaw ?? 0) !== Math.floor(byteSize / 128) - 1
  ) {
    warnings.push({ level: 'warn', message: 'EEPROM 大小字段与输入长度不一致，导出值按输入长度计算。' })
  }

  return { xml: `${lines.join('\n')}\n`, warnings }
}

// Backwards-compatible wrapper used by the parser page's "导出 XML" action.
export function exportEsiXml(result) {
  return generateEsiXml(result)
}

// Rebuilds an SII image from generated ESI XML and compares it with the dump
// the XML was derived from. Pass null when there is no source dump.
export function verifyEsiXml(xmlText, expectedBytes = null, options = {}) {
  const generated = generateSiiFromEsi(xmlText, options)
  if (!expectedBytes) {
    return {
      ...generated,
      expectedLength: null,
      actualLength: generated.bytes.length,
      identical: null,
      diffCount: 0,
      firstDiffs: [],
    }
  }

  const expected = expectedBytes
  const length = Math.max(expected.length, generated.bytes.length)
  let diffCount = 0
  const firstDiffs = []
  for (let offset = 0; offset < length; offset++) {
    const expectedByte = offset < expected.length ? expected[offset] : null
    const actualByte = offset < generated.bytes.length ? generated.bytes[offset] : null
    if (expectedByte !== actualByte) {
      diffCount += 1
      if (firstDiffs.length < 8) {
        firstDiffs.push({ offset, expected: expectedByte, actual: actualByte })
      }
    }
  }

  return {
    ...generated,
    expectedLength: expected.length,
    actualLength: generated.bytes.length,
    identical: diffCount === 0,
    diffCount,
    firstDiffs,
  }
}
