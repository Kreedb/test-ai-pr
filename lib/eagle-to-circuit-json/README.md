# eagle-to-circuit-json

Convert EAGLE 6+ XML boards (`.brd`) and schematics (`.sch`) into
[Circuit JSON](https://github.com/tscircuit/circuit-json). Pure ESM; the only
dependency is `fast-xml-parser`.

This package exists because the published EAGLE converters stop at an
EAGLE-shaped JSON: they do not emit Circuit JSON, so they cannot feed a KiCad
writer without a mapping layer. The mapping lives here.

## Install

```bash
npm install eagle-to-circuit-json
```

## Usage

```js
import { parseEagleXml, eagleToCircuitJson, looksLikeEagleXml } from 'eagle-to-circuit-json'

const text = new TextDecoder().decode(bytes)
if (!looksLikeEagleXml(text)) throw new Error('not EAGLE XML')

const { board, schematic } = parseEagleXml(text)
const circuitJson = eagleToCircuitJson({ board, schematic })
```

`eagleToCircuitJson` accepts either document (or both) and returns a flat
Circuit JSON array. Passing both merges components by reference designator and
joins nets through `source_port_id`, which is what the preview and the KiCad
writer use for cross-probing.

An optional second argument collects warnings:

```js
const warnings = []
eagleToCircuitJson({ board }, warnings)
```

## Exports

| Export | Purpose |
| --- | --- |
| `looksLikeEagleXml(text)` | Content sniffing; `.brd` is also Cadence Allegro's extension |
| `parseEagleXml(text)` | Parse into `{ version, board, schematic }` subtrees |
| `eagleToCircuitJson({ board, schematic }, warnings?)` | Map to Circuit JSON |

## Coordinate conventions

- EAGLE stores millimetres with Y up, which is also Circuit JSON's PCB frame, so
  board coordinates pass through unchanged.
- Schematic Circuit JSON is consumed by `circuit-json-to-kicad` at 15x the
  source millimetres, so schematic coordinates, stroke widths and font sizes are
  divided by 15 on the way in.
- Pad and graphic positions are absolute board coordinates. The KiCad writer
  converts them back into footprint-local coordinates; do not pre-unrotate.

## Known limitations

- `wire curve` is ignored: arcs become straight chords on the target layer.
- Thermal/antipad geometry is not emitted; only the finished pad is kept.
- 3D models, attributes, design rules and net classes have no Circuit JSON
  field and are dropped.

## License

GPL-3.0-only.
