<script setup>
import { hex, hexBytes } from '@/lib/format'

defineProps({
  dc: { type: Object, required: true },
})
</script>

<template>
  <div class="dc-list">
    <div v-for="element in dc.elements" :key="element.index" class="dc-element">
      <div class="dc-head">
        <span class="badge">模式 {{ element.index + 1 }}</span>
        <strong>{{ element.name || '未命名' }}</strong>
        <span v-if="element.description" class="muted small">{{ element.description }}</span>
        <span class="badge mono">AssignActivate {{ hex(element.assignActivate, 4) }}</span>
      </div>

      <div class="table-wrap">
        <table class="data-table dc-table">
          <tbody>
            <tr>
              <th>Sync0 周期时间</th>
              <td class="mono">{{ element.sync0CycleTime }} ns</td>
              <th>Sync0 偏移时间</th>
              <td class="mono">{{ element.sync0ShiftTime }} ns</td>
            </tr>
            <tr>
              <th>Sync1 偏移时间</th>
              <td class="mono">{{ element.sync1ShiftTime }} ns</td>
              <th>Sync1 周期因子</th>
              <td class="mono">{{ element.sync1CycleFactor }}</td>
            </tr>
            <tr>
              <th>Sync0 周期因子</th>
              <td class="mono">{{ element.sync0CycleFactor }}</td>
              <th>字符串索引</th>
              <td class="mono">名称 {{ element.nameIndex }} · 描述 {{ element.descIndex }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="mono small muted">原始 24 字节：{{ hexBytes(element.raw, 24) }}</p>
    </div>
  </div>
</template>
