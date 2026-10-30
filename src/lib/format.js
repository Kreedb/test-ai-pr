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

export function parseHexValue(text) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/^(?:#x|0x)/i, '')
    .replace(/[^0-9a-f]/gi, '')
  return cleaned ? parseInt(cleaned, 16) : 0
}

export function parseDecValue(text, fallback = 0) {
  const value = Number.parseInt(String(text ?? '').trim(), 10)
  return Number.isFinite(value) ? value : fallback
}
