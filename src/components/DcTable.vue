<script setup>
import { dcRaw } from '@/lib/editor'
import { hex, hexBytes, parseDecValue, parseHexValue } from '@/lib/format'

defineProps({
  dc: { type: Object, required: true },
})

const emit = defineEmits(['update', 'add', 'remove'])
</script>

<template>
  <div class="dc-list">
    <div v-for="(element, index) in dc.elements" :key="index" class="dc-element">
      <div class="dc-head">
        <span class="badge">模式 {{ index + 1 }}</span>
        <strong>{{ element.name || '未命名' }}</strong>
        <span v-if="element.description" class="muted small">{{ element.description }}</span>
        <span class="badge mono">AssignActivate {{ hex(element.assignActivate, 4) }}</span>
        <span class="spacer"></span>
        <button type="button" class="btn small ghost" @click="emit('remove', index)">删除</button>
      </div>

      <div class="form-grid compact-grid">
        <label class="field">
          <span>名称</span>
          <input
            :value="element.name"
            @input="emit('update', index, 'name', $event.target.value)"
          />
        </label>
        <label class="field">
          <span>描述</span>
          <input
            :value="element.description"
            @input="emit('update', index, 'description', $event.target.value)"
          />
        </label>
        <label class="field">
          <span>AssignActivate（十六进制）</span>
          <input
            class="mono"
            :value="hex(element.assignActivate, 4)"
            spellcheck="false"
            @change="emit('update', index, 'assignActivate', parseHexValue($event.target.value) & 0xffff)"
          />
        </label>
        <label class="field">
          <span>Sync0 周期时间（ns）</span>
          <input
            class="mono"
            :value="element.sync0CycleTime"
            @change="emit('update', index, 'sync0CycleTime', parseDecValue($event.target.value) >>> 0)"
          />
        </label>
        <label class="field">
          <span>Sync0 偏移时间（ns）</span>
          <input
            class="mono"
            :value="element.sync0ShiftTime"
            @change="emit('update', index, 'sync0ShiftTime', parseDecValue($event.target.value) >>> 0)"
          />
        </label>
        <label class="field">
          <span>Sync0 周期因子</span>
          <input
            class="mono"
            :value="element.sync0CycleFactor"
            @change="emit('update', index, 'sync0CycleFactor', parseDecValue($event.target.value) & 0xffff)"
          />
        </label>
        <label class="field">
          <span>Sync1 周期时间</span>
          <input
            class="mono"
            :value="element.sync1CycleFactor"
            @change="emit('update', index, 'sync1CycleFactor', parseDecValue($event.target.value) & 0xffff)"
          />
        </label>
        <label class="field">
          <span>Sync1 偏移时间（ns）</span>
          <input
            class="mono"
            :value="element.sync1ShiftTime"
            @change="emit('update', index, 'sync1ShiftTime', parseDecValue($event.target.value) >>> 0)"
          />
        </label>
      </div>

      <p class="mono small muted">原始 24 字节：{{ hexBytes(dcRaw(element), 24) }}</p>
    </div>
  </div>
  <div class="actions">
    <button type="button" class="btn small" @click="emit('add')">添加操作模式</button>
  </div>
</template>
