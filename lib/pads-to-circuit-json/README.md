# pads-to-circuit-json

Convert PADS Layout ASCII exports (`.asc`) into
[Circuit JSON](https://github.com/tscircuit/circuit-json). Pure ESM, no
dependencies.

This package exists because the upstream `padsts` / `pads-to-circuit-json`
projects publish TypeScript sources without a build (or are not on npm at all),
so they cannot be imported by Node ESM or Vite. The parser and mapping are
reimplemented here from the documented export format.

## Install

```bash
npm install pads-to-circuit-json
```

## Usage

```js
import { looksLikePadsAscii, parsePadsAscii, padsToCircuitJson } from 'pads-to-circuit-json'

const text = new TextDecoder().decode(bytes)
if (!looksLikePadsAscii(text)) throw new Error('not a PADS ASCII export')

const parsed = parsePadsAscii(text)
const circuitJson = padsToCircuitJson(parsed)
```

`padsToCircuitJson(parsed, warnings?)` returns a flat Circuit JSON array;
simplifications are pushed into the optional `warnings` array.

## Exports

| Export | Purpose |
| --- | --- |
| `looksLikePadsAscii(text)` | Detect the `!PADS-POWERPCB-...!` banner |
| `parsePadsAscii(text)` | Parse sections into layers, decals, parts, nets, routes |
| `padsToCircuitJson(parsed, warnings?)` | Map to Circuit JSON |

## Format notes

- The preamble is `!PADS-POWERPCB-<version>-<UNITS>!` (or the BASIC
  `*PADS-POWERPCB-...*` variant), followed by `*SECTION*` headers: `PCB`,
  `LAYER`, `VIA`, `PARTDECAL`, `PARTTYPE`, `PART`, `NET`/`ROUTE`, `LINES`,
  `TEXT`, `MISC`, `END`.
- Units come from the header suffix (`BASIC`, `MILS`, `INCHES`, `METRIC`).
  BASIC-unit files still say `UNITS 0` in `*PCB*`, so the header wins.
- Pad layer levels: `-2` mounted/top copper, `0` opposite copper, `-1` inner
  copper, `>0` explicit level.
- Field order follows PADS V9 and later; older files may differ.

## Known limitations

- Only ASCII `.asc` is supported. Binary `.pcb` and PADS Logic schematics are
  not.
- Thermal (`RT`/`ST`), antipad (`RA`/`SA`) and annular (`A`) rows are clearance
  geometry and are not emitted as pads.
- Arc routing is emitted as straight segments; arcs in board outlines are
  flattened.
- Design rules, stackup materials, blind/buried via definitions and
  assembly/solder-mask/paste graphics are dropped.

## License

GPL-3.0-only.
