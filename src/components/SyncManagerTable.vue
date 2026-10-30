<script setup>
import { SM_ENABLE_BITS, setBits, smTypeName } from '@/lib/sii'
import { hex, parseDecValue, parseHexValue } from '@/lib/format'

defineProps({
  syncManagers: { type: Array, required: true },
})

const emit = defineEmits(['update', 'add', 'remove'])

function modeLabel(control) {
  if ((control & 0x03) === 0x00) return 'Buffered'
  if ((control & 0x03) === 0x02) return 'Mailbox'
  return `Mode ${control & 0x03}`
}

function directionLabel(control) {
  const direction = (control >> 2) & 0x03
  if (direction === 0x00) return 'Master read'
  if (direction === 0x01) return 'Master write'
  return `Dir ${direction}`
}
</script>

<template>
  <div class="table-wrap">
    <table class="data-table editable-table">
      <thead>
        <tr>
          <th>#</th>
          <th>起始地址</th>
          <th>长度（字节）</th>
          <th>控制字</th>
          <th>模式 / 方向</th>
          <th>状态</th>
          <th>使能</th>
          <th>类型</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(sm, index) in syncManagers" :key="index">
          <td class="mono">{{ sm.index }}</td>
          <td>
            <input
              class="table-input mono narrow"
              :value="hex(sm.startAddress, 4)"
              spellcheck="false"
              @change="emit('update', index, 'startAddress', parseHexValue($event.target.value) & 0xffff)"
            />
          </td>
          <td>
            <input
              class="table-input mono narrow"
              :value="sm.length"
              @change="emit('update', index, 'length', parseDecValue($event.target.value) & 0xffff)"
            />
          </td>
          <td>
            <input
              class="table-input mono narrow"
              :value="hex(sm.control, 2)"
              spellcheck="false"
              @change="emit('update', index, 'control', parseHexValue($event.target.value) & 0xff)"
            />
            <span v-if="sm.control & 0x40" class="badge">WD</span>
          </td>
          <td class="small nowrap">
            {{ modeLabel(sm.control) }} / {{ directionLabel(sm.control) }}
          </td>
          <td>
            <input
              class="table-input mono narrow"
              :value="hex(sm.status, 2)"
              spellcheck="false"
              @change="emit('update', index, 'status', parseHexValue($event.target.value) & 0xff)"
            />
          </td>
          <td>
            <input
              class="table-input mono narrow"
              :value="hex(sm.enable, 2)"
              spellcheck="false"
              @change="emit('update', index, 'enable', parseHexValue($event.target.value) & 0xff)"
            />
            <div v-if="setBits(sm.enable, SM_ENABLE_BITS).length" class="chip-row compact">
              <span
                v-for="label in setBits(sm.enable, SM_ENABLE_BITS)"
                :key="label"
                class="chip"
              >{{ label }}</span>
            </div>
          </td>
          <td>
            <input
              class="table-input mono narrow"
              :value="sm.type"
              @change="emit('update', index, 'type', parseDecValue($event.target.value) & 0xff)"
            />
            <span class="muted small nowrap">{{ smTypeName(sm.type, sm.control) }}</span>
          </td>
          <td class="row-actions">
            <button type="button" class="btn small ghost" @click="emit('remove', index)">
              删除
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  <div class="actions">
    <button type="button" class="btn small" @click="emit('add')">添加 SyncManager</button>
  </div>
</template>
