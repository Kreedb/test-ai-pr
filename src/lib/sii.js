// EtherCAT SII (Slave Information Interface) EEPROM parser.
//
// The EEPROM is word addressed and little endian. The first 0x40 words are a
// fixed header; from word 0x40 on, a chain of category blocks follows:
//
//   word 0: category type
//   word 1: category size in words (excluding this two-word header)
//   word 2..: category data
//
// References:
//   ETG.1000.6 Table 16 (fixed header), Table 19 (categories), Table 21 (General)
//   ETG.2010   Table 2 (fixed header), Table 6 (Strings), Table 12 (DC), Table 14 (PDO)
//
// Malformed input never throws from the category walker; problems are collected
// in `warnings` so the UI can show a partial parse.

export const HEADER_BYTES = 0x80
export const CATEGORY_START_WORD = 0x40

// Upper bound for EEPROM images accepted by the UI and the ESI generator.
export const MAX_INPUT_BYTES = 512 * 1024

export const CATEGORY_TYPE = {
  STRINGS: 10,
  DATA_TYPES: 20,
  GENERAL: 30,
  FMMU: 40,
  SYNC_MANAGER: 41,
  FMMU_EXTENDED: 42,
  SYNC_UNIT: 43,
  TX_PDO: 50,
  RX_PDO: 51,
  DC: 60,
  END: 0xffff,
}

const CATEGORY_NAMES = {
  0: 'Nop',
  10: 'Strings',
  20: 'Data Types',
  30: 'General',
  40: 'FMMU',
  41: 'SyncManager',
  42: 'FMMU Extended',
  43: 'SyncUnit',
  50: 'TxPDO',
  51: 'RxPDO',
  60: 'DC',
  0xffff: 'End',
}

export function categoryName(type) {
  if (CATEGORY_NAMES[type]) return CATEGORY_NAMES[type]
  return type < 0x1000 ? 'Device Specific' : 'Vendor Specific'
}

export const MAILBOX_PROTOCOLS = [
  { bit: 0x01, label: 'AoE' },
  { bit: 0x02, label: 'EoE' },
  { bit: 0x04, label: 'CoE' },
  { bit: 0x08, label: 'FoE' },
  { bit: 0x10, label: 'SoE' },
  { bit: 0x20, label: 'VoE' },
]

export const COE_DETAIL_BITS = [
  { bit: 0x01, label: 'SDO' },
  { bit: 0x02, label: 'SDO Info' },
  { bit: 0x04, label: 'PDO Assign' },
  { bit: 0x08, label: 'PDO Config' },
  { bit: 0x10, label: 'Upload at startup' },
  { bit: 0x20, label: 'Complete Access' },
]

export const GENERAL_FLAG_BITS = [
  { bit: 0x01, label: 'Enable SafeOp' },
  { bit: 0x02, label: 'Enable not-LRW' },
  { bit: 0x04, label: 'Mailbox DLL' },
  { bit: 0x08, label: 'Identification via AL Status' },
  { bit: 0x10, label: 'Identification via Physical Memory' },
]

export const PORT_TYPES = ['Unused', 'MII', 'Reserved', 'EBUS', 'Fast Hot Connect']

export const FMMU_USAGE = {
  0x00: 'Unused',
  0x01: 'Outputs',
  0x02: 'Inputs',
  0x03: 'SM Status',
  0xff: 'Unused',
}

export const SM_ENABLE_BITS = [
  { bit: 0x01, label: 'Enable' },
  { bit: 0x02, label: 'Fixed content' },
  { bit: 0x04, label: 'Virtual' },
  { bit: 0x08, label: 'OpOnly' },
]

export const SM_TYPE_NAMES = [
  'Unknown',
  'Mailbox Write',
  'Mailbox Read',
  'Process Data Write',
  'Process Data Read',
]

export const PDO_SYNC_NAMES = ['FreeRun', 'SyncManager', 'DC Sync0', 'DC Sync1']

export const PDO_FLAG_BITS = [
  { bit: 0x0001, label: 'Mandatory' },
  { bit: 0x0002, label: 'Default' },
  { bit: 0x0004, label: 'Oversample' },
  { bit: 0x0010, label: 'Fixed Content' },
  { bit: 0x0020, label: 'Virtual Content' },
  { bit: 0x0040, label: 'Download Anyway' },
  { bit: 0x0080, label: 'From Module' },
  { bit: 0x0100, label: 'Module Align' },
  { bit: 0x0200, label: 'Depend on Slot' },
  { bit: 0x0400, label: 'Depend on Slot Group' },
  { bit: 0x0800, label: 'Overwritten by Module' },
  { bit: 0x1000, label: 'Configurable' },
  { bit: 0x2000, label: 'Auto PDO Name' },
  { bit: 0x4000, label: 'Disable Auto Exclude' },
  { bit: 0x8000, label: 'Writable' },
]

// ETG.1000.6 Table 12 data type codes used by SII PDO entries.
export const DATA_TYPE_NAMES = {
  1: 'BOOLEAN',
  2: 'INTEGER8',
  3: 'INTEGER16',
  4: 'INTEGER32',
  5: 'UNSIGNED8',
  6: 'UNSIGNED16',
  7: 'UNSIGNED32',
  8: 'REAL32',
  9: 'VISIBLE_STRING',
  10: 'OCTET_STRING',
  11: 'UNICODE_STRING',
  12: 'TIME_OF_DAY',
  13: 'TIME_DIFFERENCE',
  14: 'DOMAIN',
  15: 'INTEGER24',
  16: 'REAL64',
  17: 'INTEGER40',
  18: 'INTEGER48',
  19: 'INTEGER56',
  20: 'INTEGER64',
  21: 'UNSIGNED24',
  22: 'UNSIGNED40',
  23: 'UNSIGNED48',
  24: 'UNSIGNED56',
  25: 'UNSIGNED64',
  26: 'BIT1',
  27: 'BIT2',
  28: 'BIT3',
  29: 'BIT4',
  30: 'BIT5',
  31: 'BIT6',
  32: 'BIT7',
  33: 'BIT8',
}

export function dataTypeName(code) {
  return DATA_TYPE_NAMES[code] || `Type ${code}`
}

export function setBits(value, definitions) {
  return definitions.filter((d) => (value & d.bit) !== 0).map((d) => d.label)
}

function readU16(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) return null
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readI16(bytes, offset) {
  const value = readU16(bytes, offset)
  if (value === null) return null
  return value & 0x8000 ? value - 0x10000 : value
}

function readU32(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return null
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function readWord(bytes, wordIndex) {
  return readU16(bytes, wordIndex * 2)
}

// CRC-8, polynomial 0x07, initial value 0xFF, no reflection. The SII fixed
// header checksum covers the first 14 bytes and is stored in word 0x0007.
export function crc8Sii(bytes, length = 14) {
  let crc = 0xff
  const end = Math.min(bytes.length, length)
  for (let i = 0; i < end; i++) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff
    }
  }
  return crc
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  }
  throw new Error('无法识别的二进制数据类型')
}

function parseInfo(bytes, warnings) {
  const checksumStored = readWord(bytes, 0x07)
  const checksumComputed = bytes.length >= 14 ? crc8Sii(bytes, 14) : null
  const checksumValid =
    checksumStored !== null && checksumComputed !== null
      ? (checksumStored & 0xff) === checksumComputed
      : null

  if (checksumValid === false) {
    warnings.push({
      level: 'warn',
      message: `固定头校验和不匹配：EEPROM 存储 0x${(checksumStored & 0xff)
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')}，按前 14 字节计算为 0x${checksumComputed
        .toString(16)
        .toUpperCase()
        .padStart(2, '0')}。`,
    })
  }

  if (bytes.length < HEADER_BYTES) {
    warnings.push({
      level: 'warn',
      message: `数据只有 ${bytes.length} 字节，短于 0x80 字节的固定头，类别区未解析。`,
    })
  }

  const sizeRaw = readWord(bytes, 0x3e)
  const declaredBytes = sizeRaw === null ? null : (sizeRaw + 1) * 128

  if (declaredBytes !== null && bytes.length < declaredBytes) {
    warnings.push({
      level: 'warn',
      message: `输入长度 ${bytes.length} 字节，短于 EEPROM 声明大小 ${declaredBytes} 字节，可能是截断的转储。`,
    })
  } else if (declaredBytes !== null && bytes.length > declaredBytes) {
    warnings.push({
      level: 'info',
      message: `输入长度 ${bytes.length} 字节，长于 EEPROM 声明大小 ${declaredBytes} 字节，尾部数据可能是填充。`,
    })
  }

  return {
    pdiControl: readWord(bytes, 0x00),
    pdiConfiguration: readWord(bytes, 0x01),
    syncImpulseLength: readWord(bytes, 0x02),
    pdiConfiguration2: readWord(bytes, 0x03),
    stationAlias: readWord(bytes, 0x04),
    reserved1: readWord(bytes, 0x05),
    reserved2: readWord(bytes, 0x06),
    checksumStored,
    checksumComputed,
    checksumValid,
    vendorId: readU32(bytes, 0x10),
    productCode: readU32(bytes, 0x14),
    revisionNumber: readU32(bytes, 0x18),
    serialNumber: readU32(bytes, 0x1c),
    executionDelay: readWord(bytes, 0x10),
    port0Delay: readWord(bytes, 0x11),
    port1Delay: readWord(bytes, 0x12),
    bootstrap: {
      rxOffset: readWord(bytes, 0x14),
      rxSize: readWord(bytes, 0x15),
      txOffset: readWord(bytes, 0x16),
      txSize: readWord(bytes, 0x17),
    },
    standard: {
      rxOffset: readWord(bytes, 0x18),
      rxSize: readWord(bytes, 0x19),
      txOffset: readWord(bytes, 0x1a),
      txSize: readWord(bytes, 0x1b),
    },
    mailboxProtocols: readWord(bytes, 0x1c),
    eepromSizeRaw: sizeRaw,
    eepromSizeBytes: declaredBytes,
    eepromVersion: readWord(bytes, 0x3f),
  }
}

function walkCategories(bytes, warnings) {
  const categories = []
  if (bytes.length < HEADER_BYTES + 4) return categories

  let offset = HEADER_BYTES
  let emptyCategories = 0

  for (let guard = 0; guard < 2048 && offset + 4 <= bytes.length; guard++) {
    const type = readU16(bytes, offset)
    const sizeWords = readU16(bytes, offset + 2)
    const dataOffset = offset + 4
    const sizeBytes = sizeWords * 2

    if (type === CATEGORY_TYPE.END) {
      categories.push({
        type,
        name: categoryName(type),
        offsetBytes: offset,
        offsetWords: offset / 2,
        dataOffsetBytes: dataOffset,
        sizeWords,
        sizeBytes: 0,
        data: bytes.subarray(dataOffset, dataOffset),
      })
      break
    }

    if (sizeWords === 0) {
      emptyCategories++
      if (emptyCategories >= 32) {
        warnings.push({
          level: 'warn',
          message: '连续出现多个空类别，EEPROM 可能未写入或已损坏，已停止遍历。',
        })
        break
      }
    } else {
      emptyCategories = 0
    }

    if (sizeBytes > bytes.length - dataOffset) {
      warnings.push({
        level: 'warn',
        message: `类别 ${categoryName(type)}（0x${type
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}）声明 ${sizeBytes} 字节，但输入只剩 ${
          bytes.length - dataOffset
        } 字节，已截断。`,
      })
      categories.push({
        type,
        name: categoryName(type),
        offsetBytes: offset,
        offsetWords: offset / 2,
        dataOffsetBytes: dataOffset,
        sizeWords,
        sizeBytes: bytes.length - dataOffset,
        truncated: true,
        data: bytes.subarray(dataOffset),
      })
      break
    }

    categories.push({
      type,
      name: categoryName(type),
      offsetBytes: offset,
      offsetWords: offset / 2,
      dataOffsetBytes: dataOffset,
      sizeWords,
      sizeBytes,
      data: bytes.subarray(dataOffset, dataOffset + sizeBytes),
    })

    offset = dataOffset + sizeBytes
  }

  return categories
}

function parseStrings(data, warnings) {
  const strings = []
  if (data.length === 0) return strings

  const count = data[0]
  let offset = 1
  for (let index = 1; index <= count; index++) {
    if (offset >= data.length) {
      warnings.push({
        level: 'warn',
        message: `Strings 类别声明 ${count} 个字符串，但数据在索引 ${index} 处结束。`,
      })
      break
    }
    const length = data[offset]
    offset += 1
    if (offset + length > data.length) {
      warnings.push({
        level: 'warn',
        message: `字符串 ${index} 声明长度 ${length} 字节，超出类别数据范围。`,
      })
      break
    }
    const raw = data.subarray(offset, offset + length)
    strings.push({
      index,
      length,
      text: decodeLatin1(raw),
      raw: Array.from(raw),
    })
    offset += length
  }

  return strings
}

function parseGeneral(data, warnings) {
  if (data.length < 18) {
    warnings.push({
      level: 'warn',
      message: `General 类别只有 ${data.length} 字节，标准长度为 18 字节，缺失字段按 0 处理。`,
    })
  }

  const at = (index) => (index < data.length ? data[index] : 0)
  const u16 = (index) => (index + 1 < data.length ? readU16(data, index) : null)
  const i16 = (index) => (index + 1 < data.length ? readI16(data, index) : null)

  const portsWord = u16(16)
  return {
    groupStringIndex: at(0),
    imageStringIndex: at(1),
    orderStringIndex: at(2),
    nameStringIndex: at(3),
    reserved: at(4),
    coeDetails: at(5),
    foeDetails: at(6),
    eoeDetails: at(7),
    soeChannels: at(8),
    ds402Channels: at(9),
    sysmanClass: at(10),
    flags: at(11),
    ebusCurrent: i16(12),
    portsWord,
    ports: portsWord === null ? null : decodePorts(portsWord),
    physicalMemoryAddress: u16(14),
    raw: Array.from(data),
  }
}

export function decodePorts(word) {
  return [
    word & 0x0f,
    (word >> 4) & 0x0f,
    (word >> 8) & 0x0f,
    (word >> 12) & 0x0f,
  ]
}

function parseFmmus(data) {
  return Array.from(data, (usage) => ({
    usage,
    label: FMMU_USAGE[usage] || `Unknown (0x${usage.toString(16).toUpperCase()})`,
  }))
}

function parseSyncManagers(data, warnings) {
  const entries = []
  if (data.length % 8 !== 0) {
    warnings.push({
      level: 'warn',
      message: `SyncManager 类别长度为 ${data.length} 字节，不是 8 的整数倍，尾部字节已忽略。`,
    })
  }

  for (let offset = 0; offset + 8 <= data.length; offset += 8) {
    const control = data[offset + 4]
    const enable = data[offset + 6]
    const type = data[offset + 7]
    entries.push({
      index: offset / 8,
      startAddress: readU16(data, offset),
      length: readU16(data, offset + 2),
      control,
      controlBits: {
        operationMode: control & 0x03,
        direction: (control >> 2) & 0x03,
        ecatEvent: (control & 0x10) !== 0,
        dlsUserEvent: (control & 0x20) !== 0,
        watchdog: (control & 0x40) !== 0,
      },
      status: data[offset + 5],
      enable,
      enableBits: setBits(enable, SM_ENABLE_BITS),
      type,
      typeName: smTypeName(type, control),
    })
  }

  return entries
}

export function smTypeName(type, control) {
  if (type >= 1 && type <= 4) return SM_TYPE_NAMES[type]
  const operationMode = control & 0x03
  const direction = (control >> 2) & 0x03
  if (operationMode === 0x02) {
    return direction === 0x01 ? 'Mailbox Write' : 'Mailbox Read'
  }
  if (operationMode === 0x00) {
    return direction === 0x01 ? 'Process Data Write' : 'Process Data Read'
  }
  return 'Unknown'
}

function parsePdos(data, warnings) {
  const pdos = []
  let offset = 0

  while (offset + 8 <= data.length) {
    const index = readU16(data, offset)
    const entryCount = data[offset + 2]
    const syncManager = data[offset + 3]
    const synchronization = data[offset + 4]
    const nameIndex = data[offset + 5]
    const flags = readU16(data, offset + 6)
    offset += 8

    // A zero-filled tail is padding, not another PDO.
    if (index === 0 && entryCount === 0 && syncManager === 0 && flags === 0) {
      break
    }

    const entries = []
    let truncated = false
    for (let i = 0; i < entryCount; i++) {
      if (offset + 8 > data.length) {
        truncated = true
        break
      }
      const dataType = data[offset + 4]
      entries.push({
        index: readU16(data, offset),
        subIndex: data[offset + 2],
        nameIndex: data[offset + 3],
        dataType,
        dataTypeName: dataTypeName(dataType),
        bitLength: data[offset + 5],
        flags: readU16(data, offset + 6),
      })
      offset += 8
    }

    pdos.push({
      index,
      entryCount,
      syncManager,
      synchronization,
      syncName: PDO_SYNC_NAMES[synchronization] || `Unknown (${synchronization})`,
      nameIndex,
      flags,
      flagLabels: setBits(flags, PDO_FLAG_BITS),
      entries,
      totalBits: entries.reduce((sum, entry) => sum + entry.bitLength, 0),
      truncated,
    })

    if (truncated) {
      warnings.push({
        level: 'warn',
        message: `PDO 0x${index
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')} 声明 ${entryCount} 个条目，但类别数据提前结束。`,
      })
      break
    }
  }

  if (offset < data.length) {
    const rest = data.subarray(offset)
    if (rest.some((byte) => byte !== 0)) {
      warnings.push({
        level: 'warn',
        message: `PDO 类别末尾有 ${rest.length} 字节未解析数据。`,
      })
    }
  }

  return pdos
}

function parseDc(data, warnings) {
  if (data.length % 24 !== 0) {
    warnings.push({
      level: 'warn',
      message: `DC 类别长度为 ${data.length} 字节，不是 24（每个操作模式）的整数倍。`,
    })
  }

  const elements = []
  for (let offset = 0; offset + 24 <= data.length; offset += 24) {
    elements.push({
      index: elements.length,
      sync0CycleTime: readU32(data, offset),
      sync0ShiftTime: readU32(data, offset + 0x04),
      sync1ShiftTime: readU32(data, offset + 0x08),
      sync1CycleFactor: readU16(data, offset + 0x0c),
      assignActivate: readU16(data, offset + 0x0e),
      sync0CycleFactor: readU16(data, offset + 0x10),
      nameIndex: data[offset + 0x12],
      descIndex: data[offset + 0x13],
      raw: Array.from(data.subarray(offset, offset + 24)),
    })
  }

  return { elements }
}

function decodeLatin1(bytes) {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return text
}

function resolveStrings(result) {
  const byIndex = new Map(result.strings.map((entry) => [entry.index, entry.text]))
  const stringAt = (index) => (index ? byIndex.get(index) || '' : '')

  if (result.general) {
    result.general.groupName = stringAt(result.general.groupStringIndex)
    result.general.imageName = stringAt(result.general.imageStringIndex)
    result.general.orderName = stringAt(result.general.orderStringIndex)
    result.general.deviceName = stringAt(result.general.nameStringIndex)
  }

  for (const pdo of [...result.txPdos, ...result.rxPdos]) {
    pdo.name = stringAt(pdo.nameIndex)
    for (const entry of pdo.entries) {
      entry.name = stringAt(entry.nameIndex)
    }
  }

  if (result.dc) {
    for (const element of result.dc.elements) {
      element.name = stringAt(element.nameIndex)
      element.description = stringAt(element.descIndex)
    }
  }
}

export function parseSii(input) {
  const bytes = asBytes(input)
  if (bytes.length === 0) throw new Error('没有可解析的数据')

  const warnings = []
  if (bytes.length % 2 !== 0) {
    warnings.push({
      level: 'info',
      message: '输入字节数为奇数，最后一个字节无法组成完整的 EEPROM 字。',
    })
  }

  const info = parseInfo(bytes, warnings)
  const categories = walkCategories(bytes, warnings)

  const result = {
    bytes,
    byteLength: bytes.length,
    wordCount: Math.ceil(bytes.length / 2),
    info,
    categories,
    strings: [],
    general: null,
    fmmus: [],
    syncManagers: [],
    txPdos: [],
    rxPdos: [],
    dc: null,
    dataTypes: null,
    warnings,
  }

  const seen = new Set()
  const singletonTypes = new Set([
    CATEGORY_TYPE.STRINGS,
    CATEGORY_TYPE.DATA_TYPES,
    CATEGORY_TYPE.GENERAL,
    CATEGORY_TYPE.FMMU,
    CATEGORY_TYPE.SYNC_MANAGER,
    CATEGORY_TYPE.TX_PDO,
    CATEGORY_TYPE.RX_PDO,
    CATEGORY_TYPE.DC,
  ])

  for (const category of categories) {
    if (singletonTypes.has(category.type)) {
      if (seen.has(category.type)) {
        warnings.push({
          level: 'info',
          message: `类别 ${category.name} 出现多次，仅使用第一个。`,
        })
        continue
      }
      seen.add(category.type)
    }

    switch (category.type) {
      case CATEGORY_TYPE.STRINGS:
        result.strings = parseStrings(category.data, warnings)
        break
      case CATEGORY_TYPE.DATA_TYPES:
        result.dataTypes = category.data
        break
      case CATEGORY_TYPE.GENERAL:
        result.general = parseGeneral(category.data, warnings)
        break
      case CATEGORY_TYPE.FMMU:
        result.fmmus = parseFmmus(category.data)
        break
      case CATEGORY_TYPE.SYNC_MANAGER:
        result.syncManagers = parseSyncManagers(category.data, warnings)
        break
      case CATEGORY_TYPE.TX_PDO:
        result.txPdos = parsePdos(category.data, warnings)
        break
      case CATEGORY_TYPE.RX_PDO:
        result.rxPdos = parsePdos(category.data, warnings)
        break
      case CATEGORY_TYPE.DC:
        result.dc = parseDc(category.data, warnings)
        break
      default:
        break
    }
  }

  resolveStrings(result)
  return result
}
