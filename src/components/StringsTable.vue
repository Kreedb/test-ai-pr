<script setup>
import { printable } from '@/lib/format'

defineProps({
  strings: { type: Array, required: true },
})
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>索引</th>
          <th>长度</th>
          <th>字符串</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in strings" :key="entry.index">
          <td class="mono">{{ entry.index }}</td>
          <td class="mono">{{ entry.length }}</td>
          <td class="mono">{{ printable(entry.text) || '—' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
