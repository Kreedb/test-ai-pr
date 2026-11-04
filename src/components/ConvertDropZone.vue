<script setup>
import { formatBytes } from '@/lib/format'

defineProps({
  dragging: { type: Boolean, default: false },
  maxInputBytes: { type: Number, required: true },
  maxTotalBytes: { type: Number, required: true },
})

const emit = defineEmits(['files', 'update:dragging'])

function onDrop(event) {
  emit('update:dragging', false)
  emit('files', event.dataTransfer?.files)
}

function onFileChange(event) {
  emit('files', event.target.files)
  event.target.value = ''
}
</script>

<template>
  <label class="drop-zone" :class="{ dragging }" @dragover.prevent="emit('update:dragging', true)" @dragleave.prevent="emit('update:dragging', false)" @drop.prevent="onDrop">
    <input type="file" multiple accept=".PcbDoc,.SchDoc,.pcbdoc,.schdoc,.PrjPcb,.prjpcb,.dsn,.ses,.asc,.brd,.sch,.edif,.zip" @change="onFileChange" />
    <span class="drop-title"> 拖拽 Altium / Specctra / EAGLE / PADS 文件或 .zip 压缩包到这里，或点击选择文件 </span>
    <span class="drop-hint">
      支持 .PcbDoc、.SchDoc、.dsn、.ses、.brd、.sch、.asc，可一次选择整个工程，也可以直接上传 .zip； 压缩包会在浏览器内解开，仅保留可转换的文件。单个文件上限
      {{ formatBytes(maxInputBytes) }}，合计上限 {{ formatBytes(maxTotalBytes) }}。
    </span>
  </label>
</template>
