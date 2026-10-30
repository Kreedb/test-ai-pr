<script setup>
import { hex } from '@/lib/format'

defineProps({
  syncManagers: { type: Array, required: true },
})

function modeLabel(control) {
  if (control.operationMode === 0x00) return 'Buffered'
  if (control.operationMode === 0x02) return 'Mailbox'
  return `Mode ${control.operationMode}`
}

function directionLabel(control) {
  if (control.direction === 0x00) return 'Master read'
  if (control.direction === 0x01) return 'Master write'
  return `Dir ${control.direction}`
}
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>#</th>
          <th>起始地址</th>
          <th>长度</th>
          <th>控制字</th>
          <th>模式 / 方向</th>
          <th>使能</th>
          <th>类型</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="sm in syncManagers" :key="sm.index">
          <td class="mono">{{ sm.index }}</td>
          <td class="mono">{{ hex(sm.startAddress, 4) }}</td>
          <td class="mono">{{ hex(sm.length, 4) }} <span class="muted small">({{ sm.length }} B)</span></td>
          <td class="mono">
            {{ hex(sm.control, 2) }}
            <span v-if="sm.controlBits.watchdog" class="badge">WD</span>
          </td>
          <td class="small">
            {{ modeLabel(sm.controlBits) }} / {{ directionLabel(sm.controlBits) }}
          </td>
          <td>
            <span class="mono">{{ hex(sm.enable, 2) }}</span>
            <div v-if="sm.enableBits.length" class="chip-row compact">
              <span v-for="label in sm.enableBits" :key="label" class="chip">{{ label }}</span>
            </div>
          </td>
          <td>
            {{ sm.typeName }}
            <span v-if="sm.type" class="badge mono">0x{{ sm.type.toString(16).toUpperCase() }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
