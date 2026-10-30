<script setup>
import { DATA_TYPE_NAMES, PDO_FLAG_BITS, PDO_SYNC_NAMES, setBits } from '@/lib/sii'
import { hex, parseDecValue, parseHexValue } from '@/lib/format'

defineProps({
  pdos: { type: Array, required: true },
})

const emit = defineEmits([
  'update-pdo',
  'remove-pdo',
  'add-pdo',
  'add-entry',
  'update-entry',
  'remove-entry',
])

const DATA_TYPE_CHOICES = Object.entries(DATA_TYPE_NAMES).map(([code, name]) => ({
  value: Number(code),
  name,
}))
const SYNC_CHOICES = PDO_SYNC_NAMES.map((name, value) => ({ value, name }))

function totalBits(pdo) {
  return pdo.entries.reduce((sum, entry) => sum + (Number(entry.bitLength) || 0), 0)
}
</script>

<template>
  <div class="pdo-list">
    <details v-for="(pdo, pdoIndex) in pdos" :key="pdoIndex" class="pdo" :open="pdoIndex === 0">
      <summary class="pdo-summary">
        <span class="mono pdo-index">{{ hex(pdo.index, 4) }}</span>
        <span class="pdo-name">{{ pdo.name || '未命名' }}</span>
        <span class="badge">SM {{ pdo.syncManager === 0xff ? '—' : pdo.syncManager }}</span>
        <span class="badge">{{ PDO_SYNC_NAMES[pdo.synchronization] || `Sync ${pdo.synchronization}` }}</span>
        <span class="badge mono">flags {{ hex(pdo.flags, 4) }}</span>
        <span class="muted small">{{ pdo.entries.length }} 项 · {{ totalBits(pdo) }} bit</span>
      </summary>

      <div class="form-grid compact-grid">
        <label class="field">
          <span>索引（十六进制）</span>
          <input
            class="mono"
            :value="hex(pdo.index, 4)"
            spellcheck="false"
            @change="emit('update-pdo', pdoIndex, 'index', parseHexValue($event.target.value) & 0xffff)"
          />
        </label>
        <label class="field">
          <span>SyncManager（255 = 无）</span>
          <input
            class="mono"
            :value="pdo.syncManager"
            @change="emit('update-pdo', pdoIndex, 'syncManager', parseDecValue($event.target.value) & 0xff)"
          />
        </label>
        <label class="field">
          <span>名称</span>
          <input
            :value="pdo.name"
            @input="emit('update-pdo', pdoIndex, 'name', $event.target.value)"
          />
        </label>
        <label class="field">
          <span>同步方式 *</span>
          <select
            :value="pdo.synchronization"
            @change="emit('update-pdo', pdoIndex, 'synchronization', parseDecValue($event.target.value))"
          >
            <option v-for="choice in SYNC_CHOICES" :key="choice.value" :value="choice.value">
              {{ choice.name }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>标志（十六进制）</span>
          <input
            class="mono"
            :value="hex(pdo.flags, 4)"
            spellcheck="false"
            @change="emit('update-pdo', pdoIndex, 'flags', parseHexValue($event.target.value) & 0xffff)"
          />
        </label>
      </div>

      <div v-if="setBits(pdo.flags, PDO_FLAG_BITS).length" class="chip-row">
        <span v-for="label in setBits(pdo.flags, PDO_FLAG_BITS)" :key="label" class="chip">
          {{ label }}
        </span>
      </div>

      <div v-if="pdo.entries.length" class="table-wrap">
        <table class="data-table editable-table">
          <thead>
            <tr>
              <th>索引:子索引</th>
              <th>名称</th>
              <th>数据类型</th>
              <th>位长</th>
              <th>标志 *</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, entryIndex) in pdo.entries" :key="entryIndex">
              <td class="mono nowrap">
                <input
                  class="table-input mono narrow"
                  :value="hex(entry.index, 4)"
                  spellcheck="false"
                  @change="emit('update-entry', pdoIndex, entryIndex, 'index', parseHexValue($event.target.value) & 0xffff)"
                />
                :
                <input
                  class="table-input mono narrow"
                  :value="entry.subIndex"
                  @change="emit('update-entry', pdoIndex, entryIndex, 'subIndex', parseDecValue($event.target.value) & 0xff)"
                />
              </td>
              <td>
                <input
                  class="table-input wide"
                  :value="entry.name"
                  @input="emit('update-entry', pdoIndex, entryIndex, 'name', $event.target.value)"
                />
              </td>
              <td>
                <select
                  class="table-input"
                  :value="entry.dataType"
                  @change="emit('update-entry', pdoIndex, entryIndex, 'dataType', parseDecValue($event.target.value))"
                >
                  <option v-for="choice in DATA_TYPE_CHOICES" :key="choice.value" :value="choice.value">
                    {{ choice.name }}
                  </option>
                </select>
              </td>
              <td>
                <input
                  class="table-input mono narrow"
                  :value="entry.bitLength"
                  @change="emit('update-entry', pdoIndex, entryIndex, 'bitLength', parseDecValue($event.target.value) & 0xff)"
                />
              </td>
              <td>
                <input
                  class="table-input mono narrow"
                  :value="hex(entry.flags, 4)"
                  spellcheck="false"
                  @change="emit('update-entry', pdoIndex, entryIndex, 'flags', parseHexValue($event.target.value) & 0xffff)"
                />
              </td>
              <td class="row-actions">
                <button
                  type="button"
                  class="btn small ghost"
                  @click="emit('remove-entry', pdoIndex, entryIndex)"
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted small">该 PDO 没有条目。</p>

      <div class="actions">
        <button type="button" class="btn small" @click="emit('add-entry', pdoIndex)">
          添加条目
        </button>
        <button type="button" class="btn small ghost" @click="emit('remove-pdo', pdoIndex)">
          删除此 PDO
        </button>
      </div>
    </details>
  </div>
  <div class="actions">
    <button type="button" class="btn small" @click="emit('add-pdo')">添加 PDO</button>
  </div>
</template>
