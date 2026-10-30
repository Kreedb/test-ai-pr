export function downloadBlob(data, fileName, type) {
  const blob = new Blob([data], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
  // Revoke on the next task so browsers that start the download asynchronously
  // still have a live blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function fileBaseName(name, fallback = 'eeprom') {
  if (!name) return fallback
  return name.replace(/\.[^.]+$/, '') || fallback
}
