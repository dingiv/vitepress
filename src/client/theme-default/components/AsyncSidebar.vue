<template>
  <aside v-if="!mounted" class="VPSidebar sidebar-skeleton" />
  <VPSidebar v-else :open="open" />
</template>

<script setup>
import { ref, onMounted } from 'vue'
import VPSidebar from './VPSidebar.vue'

const props = defineProps(['open'])

// SSR 期间 mounted = false → 渲染骨架 (<aside>)
// 客户端 onMounted 触发后 → 渲染真实 VPSidebar
// 侧边栏数据由 VPSidebar 内部通过 useLayout() 在客户端计算，无需传入
const mounted = ref(false)
onMounted(function () { mounted.value = true })
</script>

<style>
.sidebar-skeleton {
  width: var(--vp-sidebar-width, 272px);
  min-height: 100vh;
  flex-shrink: 0;
}
</style>
