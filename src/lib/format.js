export function hex(value, width = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  const text = Number(value).toString(16).toUpperCase()
  return `0x${width ? text.padStart(width, '0') : text}`
}

export function hexBytes(bytes, limit = 8) {
  if (!bytes || bytes.length === 0) return '—'
  const end = Math.min(bytes.length, limit)
  const shown = []
  for (let i = 0; i < end; i++) {
    shown.push(bytes[i].toString(16).toUpperCase().padStart(2, '0'))
  }
  return shown.join(' ') + (bytes.length > limit ? ' …' : '')
}

export function formatBytes(count) {
  if (count === null || count === undefined) return '—'
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) {
    const value = count / 1024
    return `${Number.isInteger(value) ? value : value.toFixed(1)} KiB`
  }
  return `${(count / 1024 / 1024).toFixed(1)} MiB`
}

// EtherCAT strings are byte strings (usually ASCII, sometimes ISO-8859-1).
// Render control characters and NUL padding visibly instead of dropping them.
export function printable(text) {
  if (!text) return ''
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0)
    out += code < 0x20 || code === 0x7f ? '·' : char
  }
  return out
}
