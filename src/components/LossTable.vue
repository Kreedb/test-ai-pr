<script setup>
import { LOSS_GROUPS } from '@/lib/formats/index.js'

// One row per (source, lossy category), so the table can be scanned by format or
// by what kind of information is at risk rather than read as six bullet lists.
const rows = LOSS_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ source: group.source, target: group.target, ...item })),
)
</script>

<template>
  <div class="table-wrap loss-table-wrap">
    <table class="data-table loss-table">
      <thead>
        <tr>
          <th>来源</th>
          <th>输出</th>
          <th>信息类别</th>
          <th>影响</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, index) in rows" :key="index">
          <td class="nowrap">{{ row.source }}</td>
          <td class="mono small nowrap">{{ row.target }}</td>
          <td class="nowrap">{{ row.category }}</td>
          <td class="small">{{ row.detail }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
