<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

// Pan/zoom container for the schematic and board previews.
//
// The content is rendered in model coordinates (millimetres, Y up) and flipped
// once by the wrapping group, so children can draw with the same numbers the
// converter produced. The view state is a centre point plus "millimetres per
// pixel", which survives container resizes without a refit.
const props = defineProps({
  bounds: { type: Object, default: null },
  // Bumping this value re-fits the view, e.g. when the visible tab changes.
  fitKey: { type: [String, Number], default: 0 },
})

const MIN_SCALE = 0.02
const MAX_SCALE = 60
// Pointer travel, in CSS pixels, before a press counts as a pan instead of a click.
const DRAG_THRESHOLD = 3

const wrapper = ref(null)
const size = ref({ width: 0, height: 0 })
const center = ref({ x: 0, y: 0 })
const scale = ref(1)
const dragging = ref(false)
// A user pan/zoom wins over automatic re-fitting on resize; the "适应" button
// clears the flag.
const userAdjusted = ref(false)
let dragStart = null
let observer = null

const viewBox = computed(() => {
  const width = Math.max(size.value.width, 1) * scale.value
  const height = Math.max(size.value.height, 1) * scale.value
  // World Y is up, the DOM's is down: the content group flips it, so the box is
  // expressed in the flipped space.
  return `${center.value.x - width / 2} ${-(center.value.y + height / 2)} ${width} ${height}`
})

const zoomLabel = computed(() => {
  // Screen pixels per millimetre.
  const pxPerMm = 1 / scale.value
  return pxPerMm >= 1 ? `${pxPerMm.toFixed(1)}×` : `${(pxPerMm * 100).toFixed(0)}%`
})

function measure() {
  const element = wrapper.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  size.value = { width: Math.max(rect.width, 1), height: Math.max(rect.height, 1) }
}

// Frame the given world bounds with a little air around them. Small objects (a
// single pad, one net) stop zooming in at MAX_SCALE so a click does not fill the
// canvas with a 0.5 mm pad; the same bounds as the wheel keep large boards from
// being cropped by the fit.
function fitTo(bounds, { padding = 1.12 } = {}) {
  measure()
  const width = bounds ? bounds.width ?? bounds.maxX - bounds.minX : 0
  const height = bounds ? bounds.height ?? bounds.maxY - bounds.minY : 0
  if (!width && !height) {
    // A single point (an unconnected pin) has nothing to frame: centre on it at
    // a readable zoom instead of leaving the scale at whatever it was.
    center.value = { x: bounds?.minX ?? 0, y: bounds?.minY ?? 0 }
    scale.value = 1 / 8
    return
  }
  const fitScale = Math.max(
    (width * padding) / size.value.width,
    (height * padding) / size.value.height,
  )
  scale.value = Math.min(Math.max(fitScale, 1 / MAX_SCALE), 1 / MIN_SCALE)
  center.value = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  }
}

function fit() {
  userAdjusted.value = false
  fitTo(props.bounds || { minX: 0, minY: 0, maxX: 1, maxY: 1 })
}

function zoomBy(factor) {
  userAdjusted.value = true
  zoomAt(factor, { x: size.value.width / 2, y: size.value.height / 2 })
}

// Zoom around a point given in CSS pixels inside the canvas.
function zoomAt(factor, pixel) {
  const next = Math.min(Math.max(scale.value / factor, 1 / MAX_SCALE), 1 / MIN_SCALE)
  const worldX = center.value.x + (pixel.x - size.value.width / 2) * scale.value
  const worldY = center.value.y - (pixel.y - size.value.height / 2) * scale.value
  scale.value = next
  center.value = {
    x: worldX - (pixel.x - size.value.width / 2) * next,
    y: worldY + (pixel.y - size.value.height / 2) * next,
  }
}

function focus(bounds) {
  if (!bounds) return
  userAdjusted.value = true
  fitTo(bounds)
}

function onWheel(event) {
  event.preventDefault()
  const rect = wrapper.value?.getBoundingClientRect()
  if (!rect) return
  userAdjusted.value = true
  zoomAt(event.deltaY < 0 ? 1.18 : 1 / 1.18, {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  })
}

function onPointerDown(event) {
  if (event.button !== 0) return
  // The zoom overlay floats inside the container; pressing one of its buttons
  // must not arm a pan.
  if (event.target?.closest?.('.preview-zoom')) return
  dragStart = {
    x: event.clientX,
    y: event.clientY,
    center: { ...center.value },
    captured: false,
  }
}

// Capturing the pointer on pointerdown retargets the following pointerup and
// click to the container, so the zoom buttons and the canvas items would never
// see their clicks. Capture only once the pointer has travelled far enough to
// be a drag; a plain click then stays a click.
function onPointerMove(event) {
  if (!dragStart) return
  const dx = event.clientX - dragStart.x
  const dy = event.clientY - dragStart.y
  if (!dragStart.captured) {
    if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return
    dragStart.captured = true
    dragging.value = true
    userAdjusted.value = true
    try {
      wrapper.value?.setPointerCapture?.(event.pointerId)
    } catch {
      // The pointer can already be gone (a cancelled touch, an OS gesture);
      // the pan still works without capture until the pointer leaves.
    }
  }
  center.value = {
    x: dragStart.center.x - dx * scale.value,
    y: dragStart.center.y + dy * scale.value,
  }
}

function onPointerUp(event) {
  if (dragStart?.captured && wrapper.value?.hasPointerCapture?.(event.pointerId)) {
    wrapper.value.releasePointerCapture(event.pointerId)
  }
  dragging.value = false
  dragStart = null
}

onMounted(() => {
  measure()
  fit()
  if (typeof ResizeObserver === 'function' && wrapper.value) {
    // Re-fit on resize only while the user has not panned or zoomed yet, so a
    // resized window does not throw away a deliberate view.
    observer = new ResizeObserver(() => {
      measure()
      if (!userAdjusted.value) fit()
    })
    observer.observe(wrapper.value)
  }
})

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
})

watch(() => props.bounds, () => fit())
watch(
  () => props.fitKey,
  () => fit(),
)

defineExpose({ fit, focus, zoomBy })
</script>

<template>
  <div
    ref="wrapper"
    class="preview-viewport"
    :class="{ dragging }"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointerleave="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <svg :viewBox="viewBox" role="img" aria-label="设计预览">
      <g :transform="`scale(1 -1)`">
        <slot />
      </g>
    </svg>

    <div class="preview-zoom">
      <button type="button" class="btn small ghost" title="缩小" @click="zoomBy(1 / 1.3)">−</button>
      <span class="muted small">{{ zoomLabel }}</span>
      <button type="button" class="btn small ghost" title="放大" @click="zoomBy(1.3)">+</button>
      <button type="button" class="btn small ghost" title="适应窗口" @click="fit">适应</button>
    </div>
  </div>
</template>
