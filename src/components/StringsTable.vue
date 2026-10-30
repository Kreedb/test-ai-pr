<script setup>
import { stringByteLength } from '@/lib/editor'

defineProps({
  strings: { type: Array, required: true },
})

const emit = defineEmits(['update-text', 'remove'])
</script>

<template>
  <div class="table-wrap">
    <table class="data-table editable-table">
      <thead>
        <tr>
          <th>索引</th>
          <th>长度</th>
          <th>字符串</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in strings" :key="entry.index">
          <td class="mono">{{ entry.index }}</td>
          <td class="mono">{{ stringByteLength(entry.text) }}</td>
          <td>
            <input
              class="table-input mono"
              :value="entry.text"
              spellcheck="false"
              @input="emit('update-text', entry.index, $event.target.value)"
            />
          </td>
          <td class="row-actions">
            <button type="button" class="btn small ghost" @click="emit('remove', entry.index)">
              删除
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
