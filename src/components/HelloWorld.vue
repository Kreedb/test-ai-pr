<script setup>
import { ref } from 'vue'

defineProps({
  msg: {
    type: String,
    required: true,
  },
})

const count = ref(0)
</script>

<template>
  <h1>{{ msg }}</h1>

  <button type="button" class="counter" @click="count++">
    count is {{ count }}
  </button>

  <p>
    Edit
    <code>src/components/HelloWorld.vue</code> to test hot module replacement.
  </p>
</template>

<style scoped>
.counter {
  padding: 0.6em 1.2em;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-surface);
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: border-color 0.25s;
}

.counter:hover {
  border-color: var(--color-accent);
}
</style>
