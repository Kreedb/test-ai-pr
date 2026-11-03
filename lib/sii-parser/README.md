# sii-parser

EtherCAT SII (Slave Information Interface) EEPROM parser. Pure ESM, no
dependencies, no DOM, no Vue. Runs in Node and in the browser.

## Install

```bash
npm install sii-parser
```

## Usage

```js
import { parseSii, crc8Sii, MAX_INPUT_BYTES } from 'sii-parser'

const result = parseSii(bytes) // Uint8Array or ArrayBuffer

result.info // fixed header: vendor id, product code, revision, serial, mailbox
result.general // General category
result.fmmus // FMMU list
result.syncManagers // SyncManager list
result.txPdos / result.rxPdos // PDOs with entries
result.dc // DC operation modes
result.strings // string table
result.warnings // non-fatal problems found while walking categories
```

`parseSii` never throws on malformed category data: problems are collected in
`result.warnings` so a partial image can still be inspected. It throws only when
the input is empty.

## Exports

| Export | Purpose |
| --- | --- |
| `parseSii(input)` | Parse an EEPROM image into the structured result above |
| `crc8Sii(bytes, length)` | CRC-8 (poly `0x07`, init `0xFF`) over the fixed header |
| `decodePorts(word)` | Decode the four 4-bit port codes |
| `smTypeName(type, control)` | Human-readable SyncManager type |
| `categoryName(type)` | Human-readable category name |
| `setBits(value, bits)` | Toggle a bit mask (used by the editor UI) |
| `MAX_INPUT_BYTES` | 512 KiB upper bound accepted by the parser |
| `HEADER_BYTES`, `CATEGORY_START_WORD` | Layout constants |
| `CATEGORY_TYPE`, `DATA_TYPE_NAMES`, `FMMU_USAGE`, `PDO_FLAG_BITS`, `PDO_SYNC_NAMES`, `SM_ENABLE_BITS`, `GENERAL_FLAG_BITS`, `MAILBOX_PROTOCOLS`, `COE_DETAIL_BITS`, `PORT_TYPES` | Field tables used by the parser and by editors |

## Format notes

- The EEPROM is word addressed and little endian.
- The first `0x40` words are the fixed header; from word `0x40` a chain of
  category blocks follows (`type`, `size in words`, data).
- References: ETG.1000.6 (fixed header, categories, General, FMMU) and
  ETG.2010 (Strings, DC, PDO).
- Unknown and vendor-specific categories are kept as raw data instead of being
  dropped.

## License

GPL-3.0-only.
