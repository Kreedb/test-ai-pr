<script setup>
import { SOURCE_FORMATS } from '@/lib/formats/index.js'
</script>

<template>
  <div class="table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th>来源</th>
          <th>扩展名</th>
          <th>可转换内容</th>
          <th>状态</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="format in SOURCE_FORMATS" :key="format.id">
          <td class="nowrap">{{ format.label }}</td>
          <td class="mono small">{{ format.extensions.join(' / ') }}</td>
          <td class="nowrap">{{ format.converts }}</td>
          <td>
            <span class="chip" :class="format.status === 'supported' ? 'accent' : ''">
              {{ format.status === 'supported' ? '已支持' : '计划中' }}
            </span>
          </td>
          <td class="small">{{ format.note }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
