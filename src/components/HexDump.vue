<script setup>
import { computed } from 'vue'

const props = defineProps({
  bytes: { type: Uint8Array, required: true },
  limit: { type: Number, default: 16384 },
})

const shownLength = computed(() => Math.min(props.bytes.length, props.limit))

const rows = computed(() => {
  const result = []
  for (let offset = 0; offset < shownLength.value; offset += 16) {
    const slice = props.bytes.subarray(offset, Math.min(offset + 16, shownLength.value))
    const parts = []
    let ascii = ''
    for (let i = 0; i < 16; i++) {
      if (i < slice.length) {
        parts.push(slice[i].toString(16).toUpperCase().padStart(2, '0'))
        ascii += slice[i] >= 0x20 && slice[i] <= 0x7e ? String.fromCharCode(slice[i]) : '.'
      } else {
        parts.push('  ')
        ascii += ' '
      }
    }
    result.push({
      offset: offset.toString(16).toUpperCase().padStart(8, '0'),
      hex: `${parts.slice(0, 8).join(' ')}  ${parts.slice(8).join(' ')}`,
      ascii,
    })
  }
  return result
})
</script>

<template>
  <div class="hexdump">
    <div v-for="row in rows" :key="row.offset" class="hex-row">
      <span class="hex-offset">{{ row.offset }}</span>
      <span class="hex-bytes">{{ row.hex }}</span>
      <span class="hex-ascii">{{ row.ascii }}</span>
    </div>
    <p v-if="bytes.length > limit" class="muted small">
      仅显示前 {{ limit }} 字节，共 {{ bytes.length }} 字节。
    </p>
  </div>
</template>
