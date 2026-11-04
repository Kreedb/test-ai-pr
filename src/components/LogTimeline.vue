<script setup>
import { ref, watch } from 'vue'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  active: { type: Number, default: -1 },
  aligned: { type: Boolean, default: false },
  startTime: { type: Number, default: 0 },
})

const view = ref(null)

function formatTime(seconds) {
  const sign = seconds < 0 ? '-' : ''
  const value = Math.abs(seconds)
  const minutes = Math.floor(value / 60)
  const rest = value - minutes * 60
  return `${sign}${minutes}:${rest.toFixed(2).padStart(5, '0')}`
}

function relative(row) {
  return props.aligned ? formatTime(row.time - props.startTime) : row.time.toFixed(3)
}

function center() {
  const element = view.value
  const row = element?.children[props.active]
  if (!element || !row) return
  const viewRect = element.getBoundingClientRect()
  const rowRect = row.getBoundingClientRect()
  element.scrollTop += rowRect.top - viewRect.top - (viewRect.height - rowRect.height) / 2
}

watch(() => [props.active, props.rows.length], center, { flush: 'post' })
</script>

<template>
  <ul ref="view" class="log-view" aria-label="按回放时间定位的日志">
    <li v-for="(row, index) in rows" :key="index" v-memo="[row, index === active]" :class="[`log-${row.level ? row.level.toLowerCase() : 'info'}`, { 'log-current': index === active }]">
      <span class="log-time mono">{{ relative(row) }}</span>
      <span class="log-text mono">{{ row.text }}</span>
    </li>
  </ul>
</template>

<style scoped>
.log-view {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 360px;
  margin: 12px 0 0;
  padding: 10px 12px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-soft);
  list-style: none;
  font-size: 0.78rem;
}

.log-view li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  padding: 0 6px;
  border-radius: 4px;
}

.log-current {
  background: rgba(91, 140, 255, 0.16);
}

.log-time {
  flex: 0 0 auto;
  color: var(--muted);
  font-size: 0.74rem;
}

.log-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.log-w .log-text {
  color: var(--warn);
}

.log-e .log-text,
.log-f .log-text {
  color: var(--err);
}

.log-d .log-text {
  color: var(--muted);
}
</style>
