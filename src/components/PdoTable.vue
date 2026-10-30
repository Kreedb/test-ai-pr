<script setup>
import { hex } from '@/lib/format'

defineProps({
  pdos: { type: Array, required: true },
})
</script>

<template>
  <div class="pdo-list">
    <details v-for="(pdo, index) in pdos" :key="index" class="pdo" :open="index === 0">
      <summary class="pdo-summary">
        <span class="mono pdo-index">{{ hex(pdo.index, 4) }}</span>
        <span class="pdo-name">{{ pdo.name || '未命名' }}</span>
        <span class="badge">SM {{ pdo.syncManager === 0xff ? '—' : pdo.syncManager }}</span>
        <span class="badge">{{ pdo.syncName }}</span>
        <span class="badge mono">flags {{ hex(pdo.flags, 4) }}</span>
        <span class="muted small">{{ pdo.entries.length }} 项 · {{ pdo.totalBits }} bit</span>
      </summary>

      <div v-if="pdo.flagLabels.length" class="chip-row">
        <span v-for="label in pdo.flagLabels" :key="label" class="chip">{{ label }}</span>
      </div>

      <div v-if="pdo.entries.length" class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>索引:子索引</th>
              <th>名称</th>
              <th>数据类型</th>
              <th>位长</th>
              <th>标志</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(entry, entryIndex) in pdo.entries" :key="entryIndex">
              <td class="mono nowrap">{{ hex(entry.index, 4) }}:{{ hex(entry.subIndex, 2) }}</td>
              <td>{{ entry.name || '—' }}</td>
              <td class="mono">{{ entry.dataTypeName }}</td>
              <td class="mono">{{ entry.bitLength }}</td>
              <td class="mono">{{ hex(entry.flags, 4) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="muted small">该 PDO 没有条目。</p>
    </details>
  </div>
</template>
