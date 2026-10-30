<script setup>
defineProps({
  rows: { type: Array, required: true },
})
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th class="nowrap">字地址</th>
          <th>字段</th>
          <th>值</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.key">
          <td class="mono nowrap">{{ row.word }}</td>
          <td class="nowrap">{{ row.label }}</td>
          <td class="mono">{{ row.value }}</td>
          <td class="muted small">{{ row.note }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
