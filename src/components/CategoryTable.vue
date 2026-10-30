<script setup>
import { hex, hexBytes } from '@/lib/format'

defineProps({
  categories: { type: Array, required: true },
})

function preview(category) {
  if (category.type === 0xffff || category.data.length === 0) return '—'
  return hexBytes(category.data, 8)
}
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>#</th>
          <th>类型</th>
          <th>名称</th>
          <th>起始字</th>
          <th>大小（字）</th>
          <th>数据字节范围</th>
          <th>数据预览</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(category, index) in categories" :key="index">
          <td class="mono">{{ index + 1 }}</td>
          <td class="mono">{{ hex(category.type, 4) }}</td>
          <td>
            {{ category.name }}
            <span v-if="category.truncated" class="badge">截断</span>
          </td>
          <td class="mono">{{ hex(category.offsetWords, 4) }}</td>
          <td class="mono">{{ category.sizeWords }}</td>
          <td class="mono small">
            {{ hex(category.dataOffsetBytes, 4) }} –
            {{ hex(category.dataOffsetBytes + category.sizeBytes, 4) }}
          </td>
          <td class="mono small">{{ preview(category) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
