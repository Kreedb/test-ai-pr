// ZIP archive expansion for the convert page.
//
// Real EDA projects are handed around as zips (Altium "Project" export, PADS
// backup, an archive of a vendor reference design), but every converter reads a
// single document, so an archive has to be unpacked first. fflate reads the
// central directory without inflating anything, which lets the page validate
// every entry - and refuse a 4 GiB one - before a single byte is decompressed.
//
// Kept free of Vue/DOM imports so `npm test` can exercise it in Node.

const ZIP_LOCAL_HEADER = 0x04034b50
const ZIP_EMPTY_ARCHIVE = 0x06054b50

// A design archive holds a handful of documents; a hundred entries means the
// user picked a whole backup tree by accident.
export const MAX_ARCHIVE_ENTRIES = 64

// Files macOS and Windows add to every archive they touch. They are never EDA
// input, so dropping them silently keeps the file list readable.
const JUNK_PREFIXES = ['__macosx/']
const JUNK_BASENAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

export function isZipName(name) {
  return /\.zip$/i.test(String(name || ''))
}

// The picker's `accept` filter is advisory (drag and drop ignores it), and a
// renamed archive still has the right magic, so sniff the header as well.
export function looksLikeZip(bytes) {
  if (!bytes || bytes.length < 4) return false
  const magic = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  return magic === ZIP_LOCAL_HEADER || magic === ZIP_EMPTY_ARCHIVE
}

export function isZipArchive(name, bytes) {
  return isZipName(name) || looksLikeZip(bytes)
}

function pathOf(name) {
  return String(name || '').replace(/\\/g, '/')
}

function baseName(path) {
  return path.split('/').filter(Boolean).pop() || path
}

function isJunk(path) {
  const lower = path.toLowerCase()
  return (
    JUNK_PREFIXES.some((prefix) => lower.startsWith(prefix)) || JUNK_BASENAMES.has(baseName(lower))
  )
}

// Two documents can share a file name in different folders. The page keys
// entries by name, so disambiguate with the shortest distinctive path suffix
// rather than dropping one of them.
function uniqueName(path, used) {
  const parts = path.split('/').filter(Boolean)
  const base = parts.pop() || path
  if (!used.has(base)) return base
  for (let depth = 1; depth <= parts.length; depth += 1) {
    const candidate = [...parts.slice(-depth), base].join('/')
    if (!used.has(candidate)) return candidate
  }
  let index = 2
  while (used.has(`${base} (${index})`)) index += 1
  return `${base} (${index})`
}

export const SKIP_REASON_LABELS = {
  nested: '嵌套压缩包',
  unsupported: '压缩方式不受支持',
  'too-large': '超过单文件上限',
  'total-too-large': '超过合计上限',
  'too-many': '文件数量过多',
}

// fflate inflates stored (0) and deflated (8) entries only; anything else
// (LZMA, bzip2, Deflate64) would throw mid-extraction.
const SUPPORTED_COMPRESSION = new Set([0, 8])

function readEntries(unzipSync, bytes) {
  const entries = []
  // A filter that always rejects still walks the central directory and throws on
  // invalid data, so this collects every entry's declared sizes without
  // inflating anything.
  unzipSync(bytes, {
    filter: (entry) => {
      entries.push(entry)
      return false
    },
  })
  return entries
}

/**
 * Expand a zip into `{ name, bytes }` documents the converters can read.
 *
 * `maxFileBytes` / `maxTotalBytes` mirror the convert page's upload limits and
 * are applied to the *declared* uncompressed sizes, so an oversized member is
 * skipped before it is inflated. Extraction streams one member at a time and
 * also enforces the same budget on the *actual* inflated bytes; a member whose
 * header lies about its size fails the whole archive with a clear error instead
 * of growing the tab unchecked. Resolves to `{ files, skipped }`, where each
 * skipped entry carries one of `SKIP_REASON_LABELS`' keys.
 */
export async function expandArchive(
  name,
  bytes,
  { maxFileBytes = Infinity, maxTotalBytes = Infinity, maxEntries = MAX_ARCHIVE_ENTRIES } = {},
) {
  const { unzipSync, Unzip, UnzipInflate } = await import('fflate')

  let entries
  try {
    entries = readEntries(unzipSync, bytes)
  } catch (cause) {
    throw new Error(
      `${name} 不是有效的 zip 压缩包，请重新打包后再上传。(${cause.message || cause})`,
    )
  }

  const skipped = []
  const selected = []
  let total = 0

  for (const entry of entries) {
    const path = pathOf(entry.name)
    if (!path || path.endsWith('/')) continue
    if (isJunk(path)) continue
    if (!entry.originalSize) continue

    if (isZipName(path)) {
      skipped.push({ name: path, reason: 'nested' })
      continue
    }
    if (!SUPPORTED_COMPRESSION.has(entry.compression)) {
      skipped.push({ name: path, reason: 'unsupported' })
      continue
    }
    if (entry.originalSize > maxFileBytes) {
      skipped.push({ name: path, reason: 'too-large' })
      continue
    }
    if (total + entry.originalSize > maxTotalBytes) {
      skipped.push({ name: path, reason: 'total-too-large' })
      continue
    }
    if (selected.length >= maxEntries) {
      skipped.push({ name: path, reason: 'too-many' })
      continue
    }

    total += entry.originalSize
    selected.push({ path, original: entry.name })
  }

  if (!selected.length) {
    const detail = skipped.length
      ? `压缩包里的 ${skipped.length} 个文件都被跳过了（${skipped.map((item) => SKIP_REASON_LABELS[item.reason]).join('、')}）。`
      : '压缩包里没有文件。'
    throw new Error(`${name} 里没有可用的文件：${detail}`)
  }

  // fflate reports members by their raw name, which Windows-built archives may
  // spell with backslashes; look results up by that same raw name.
  const wanted = new Map(selected.map(({ path, original }) => [pathOf(original), path]))
  const used = new Set()
  const files = []
  let inflated = 0

  // Stream one member at a time and abort the whole archive the moment the
  // actual inflated bytes pass the budget. A member that lies about its
  // declared size stops here instead of growing the tab unchecked.
  const extracted = await new Promise((resolve, reject) => {
    const results = []
    let current = null
    let currentSize = 0
    let blown = false
    const stream = new Unzip()
    stream.register(UnzipInflate)
    stream.onfile = (file) => {
      const path = wanted.get(pathOf(file.name))
      if (!path) return
      current = { path, chunks: [] }
      currentSize = 0
      file.ondata = (err, chunk, final) => {
        if (err) {
          reject(new Error(`${name} 解压失败，压缩包可能已损坏。(${err.message || err})`))
          return
        }
        if (blown) return
        currentSize += chunk.length
        inflated += chunk.length
        if (currentSize > maxFileBytes || inflated > maxTotalBytes) {
          blown = true
          file.terminate()
          return
        }
        current.chunks.push(chunk)
        if (final) {
          const content = new Uint8Array(currentSize)
          let offset = 0
          for (const piece of current.chunks) {
            content.set(piece, offset)
            offset += piece.length
          }
          results.push({ path: current.path, content })
          current = null
        }
      }
      file.start()
    }
    try {
      stream.push(bytes, true)
    } catch (cause) {
      reject(new Error(`${name} 解压失败，压缩包可能已损坏。(${cause.message || cause})`))
      return
    }
    if (blown) {
      reject(
        new Error(
          `${name} 解压后超过合计上限，可能是压缩包声明的文件大小与实际不符，请重新打包后再上传。`,
        ),
      )
      return
    }
    resolve(results)
  })

  for (const { path, content } of extracted) {
    if (!content.length) continue
    const fileName = uniqueName(path, used)
    used.add(fileName)
    files.push({ name: fileName, bytes: content, path })
  }

  if (!files.length) throw new Error(`${name} 解压后没有任何内容，压缩包可能已损坏。`)

  return { files, skipped }
}
