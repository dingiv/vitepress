<template>
  <div class="particle" ref="container">
    <canvas ref="deepCanvas" class="particle-canvas deep-layer" />
    <canvas ref="midCanvas" class="particle-canvas mid-layer" />
    <canvas ref="nearCanvas" class="particle-canvas near-layer" />
    <div class="content">
      <slot></slot>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const deepCanvas = ref(null)
const midCanvas = ref(null)
const nearCanvas = ref(null)
const container = ref(null)

let deepCtx, midCtx, nearCtx
let deepParticles = [], midParticles = [], nearParticles = []
let mouse = { x: -1000, y: -1000 }
let scrollY = 0, targetScrollY = 0
let animationId = null
let orbs = []
let pageHeight = 0

/* ===== 颜色主题 ===== */
const DARK = {
  bg: '35, 28, 51',
  // 5 光球：light→dark 同色系呼吸
  orbs: [
    { light: [220, 185, 255], dark: [110, 65, 190] },   // 紫
    { light: [185, 210, 255], dark: [65, 105, 185] },   // 蓝
    { light: [255, 175, 210], dark: [185, 75, 130] },   // 粉
    { light: [170, 235, 240], dark: [55, 140, 150] },   // 青
    { light: [200, 175, 255], dark: [95, 60, 180] },    // 堇
  ],
  particles: ['140, 170, 255', '185, 145, 255', '220, 135, 225', '255, 145, 205'],
  line: '160, 155, 245',
  particleOpacity: 0.65,
  lineOpacity: 0.16,
}

const LIGHT = {
  bg: '248, 250, 255',
  orbs: [
    { light: [255, 210, 170], dark: [220, 150, 90] },   // 暖橙
    { light: [255, 235, 160], dark: [210, 175, 60] },   // 金
    { light: [255, 185, 175], dark: [210, 110, 100] },  // 珊瑚
    { light: [175, 230, 200], dark: [80, 160, 130] },   // 薄荷
    { light: [170, 210, 245], dark: [80, 135, 190] },   // 天蓝
  ],
  particles: ['255,100,100', '255,165,50', '255,210,50', '80,200,120', '50,160,255', '130,100,255'],
  line: '160, 190, 225',
  particleOpacity: 0.35,
  lineOpacity: 0.08,
}

let colors = { ...DARK }

function isDark() { return document.documentElement.classList.contains('dark') }
function updateColors() { colors = isDark() ? { ...DARK } : { ...LIGHT } }

/* ===== 大光球（固定半径，颜色呼吸：浅⇄深） ===== */
class Orb {
  constructor(depth, colorSet, baseRadius) {
    this.depth = depth
    this.parallax = depth * 0.35 + 0.1
    this.lightColor = colorSet.light
    this.darkColor = colorSet.dark
    this.radius = baseRadius
    this.x = 0
    this.y = 0
    this.phase = Math.random() * Math.PI * 2
    this.speed = 0.3 + Math.random() * 0.5
    this.driftX = Math.random() * Math.PI * 2
  }

  update(_w, dt) {
    this.phase += dt * 0.0008 * this.speed
    this.driftX += dt * 0.0001 * (0.5 + this.depth)

    // 颜色呼吸：浅 ⇄ 深 正弦插值
    const t = (Math.sin(this.phase) + 1) / 2
    this.currentColor = [
      Math.round(this.lightColor[0] + (this.darkColor[0] - this.lightColor[0]) * t),
      Math.round(this.lightColor[1] + (this.darkColor[1] - this.lightColor[1]) * t),
      Math.round(this.lightColor[2] + (this.darkColor[2] - this.lightColor[2]) * t),
    ]
  }

  draw(ctx, parallaxOffset) {
    const screenY = this.y + parallaxOffset
    const { x, radius: r } = this
    const c = this.currentColor

    // 最外层光晕
    const g4 = ctx.createRadialGradient(x, screenY, r * 0.3, x, screenY, r * 2.5)
    g4.addColorStop(0, `rgba(${c}, 0.15)`)
    g4.addColorStop(0.4, `rgba(${c}, 0.06)`)
    g4.addColorStop(0.7, `rgba(${c}, 0.01)`)
    g4.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g4
    ctx.beginPath(); ctx.arc(x, screenY, r * 2.5, 0, Math.PI * 2); ctx.fill()

    // 中层光芒
    const g2 = ctx.createRadialGradient(x, screenY, r * 0.2, x, screenY, r * 1.4)
    g2.addColorStop(0, `rgba(${c}, 0.4)`)
    g2.addColorStop(0.5, `rgba(${c}, 0.15)`)
    g2.addColorStop(1, 'rgba(0,0,0,0)')
    ctx.fillStyle = g2
    ctx.beginPath(); ctx.arc(x, screenY, r * 1.4, 0, Math.PI * 2); ctx.fill()

    // 内核
    const g1 = ctx.createRadialGradient(x, screenY, 0, x, screenY, r * 0.8)
    g1.addColorStop(0, `rgba(${c}, 0.85)`)
    g1.addColorStop(0.25, `rgba(${c}, 0.5)`)
    g1.addColorStop(0.6, `rgba(${c}, 0.15)`)
    g1.addColorStop(1, `rgba(${c}, 0.02)`)
    ctx.fillStyle = g1
    ctx.beginPath(); ctx.arc(x, screenY, r * 0.8, 0, Math.PI * 2); ctx.fill()
  }
}

/* ===== 小粒子 ===== */
class Particle {
  constructor(w, h) {
    this.x = Math.random() * w
    this.y = Math.random() * h
    this.vx = (Math.random() - 0.5) * 0.4
    this.vy = (Math.random() - 0.5) * 0.4
    this.size = Math.random() * 5 + 2
    this.colorIdx = Math.floor(Math.random() * (colors.particles?.length || 4))
  }

  update(w) {
    const dx = this.x - mouse.x
    // 将粒子世界 Y 转为视口 Y（与 draw 中的 parallaxOffset 逻辑对齐）
    const screenY = this.y - scrollY
    const dy = screenY - mouse.y
    const dist = Math.sqrt(dx * dx + dy * dy)
    if (dist < 140) {
      const force = (140 - dist) / 140
      this.vx += (dx / dist) * force * 0.08
      this.vy += (dy / dist) * force * 0.08
    }
    this.vx *= 0.999
    this.vy *= 0.999
    const ms = 1.2
    const spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy)
    if (spd > ms) { this.vx = (this.vx / spd) * ms; this.vy = (this.vy / spd) * ms }
    this.x += this.vx
    this.y += this.vy

    if (this.y < 0) this.y += pageHeight
    if (this.y > pageHeight) this.y -= pageHeight
    if (this.x < -50) this.x = w + 50
    if (this.x > w + 50) this.x = -50
  }

  draw(ctx, parallaxOffset) {
    const drawY = this.y + parallaxOffset
    const c = colors.particles[this.colorIdx % colors.particles.length]
    ctx.beginPath()
    ctx.arc(this.x, drawY, this.size, 0, Math.PI * 2)
    ctx.fillStyle = `rgba(${c}, ${colors.particleOpacity})`
    ctx.fill()
  }
}

/* ===== 初始化 ===== */
function initParticles(count, w, h) {
  const arr = []
  for (let i = 0; i < count; i++) arr.push(new Particle(w, h))
  return arr
}

function drawLines(ctx, arr, parallaxOffset, maxDist, opacity) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      const yi = arr[i].y + parallaxOffset
      const yj = arr[j].y + parallaxOffset
      const dx = arr[i].x - arr[j].x
      const dy = yi - yj
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < maxDist && Math.abs(yi - yj) < maxDist) {
        const a = (1 - dist / maxDist) * opacity
        ctx.beginPath()
        ctx.moveTo(arr[i].x, yi)
        ctx.lineTo(arr[j].x, yj)
        ctx.strokeStyle = `rgba(${colors.line}, ${a})`
        ctx.lineWidth = 0.5
        ctx.stroke()
      }
    }
  }
}

/* ===== 渲染循环 ===== */
let lastTime = 0

function animate(time) {
  const dt = lastTime ? Math.min(time - lastTime, 50) : 16
  lastTime = time

  scrollY += (targetScrollY - scrollY) * 0.08
  const w = window.innerWidth
  const h = window.innerHeight

  pageHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight * 3)

  // --- 深层画布：远景光球 + 稀疏粒子 ---
  deepCanvas.value.width = w
  deepCanvas.value.height = h
  deepCtx.clearRect(0, 0, w, innerHeight)
  const deepOffset = -scrollY * 0.12
  for (const orb of orbs) {
    orb.update(w, dt)
    orb.draw(deepCtx, deepOffset * (orb.depth * 0.7 + 0.3))
  }
  for (const p of deepParticles) { p.update(w); p.draw(deepCtx, deepOffset) }
  drawLines(deepCtx, deepParticles, deepOffset, 220, colors.lineOpacity * 0.4)

  // --- 中层画布 ---
  midCanvas.value.width = w
  midCanvas.value.height = h
  midCtx.clearRect(0, 0, w, innerHeight)
  const midOffset = -scrollY * 0.35
  for (const p of midParticles) { p.update(w); p.draw(midCtx, midOffset) }
  drawLines(midCtx, midParticles, midOffset, 180, colors.lineOpacity * 0.7)

  // --- 近层画布 ---
  nearCanvas.value.width = w
  nearCanvas.value.height = innerHeight
  nearCtx.clearRect(0, 0, w, innerHeight)
  const nearOffset = -scrollY * 0.6
  for (const p of nearParticles) { p.update(w); p.draw(nearCtx, nearOffset) }
  drawLines(nearCtx, nearParticles, nearOffset, 140, colors.lineOpacity)

  animationId = requestAnimationFrame(animate)
}

/* ===== 事件 ===== */
let prevW = window.innerWidth
function onMouseMove(e) { mouse.x = e.clientX; mouse.y = e.clientY }
function onScroll() { targetScrollY = window.scrollY }
function onResize() {
  const w = window.innerWidth
  const ratio = prevW > 0 ? w / prevW : 1
  for (const orb of orbs) { orb.x *= ratio }
  prevW = w
}

let observer = null

onMounted(() => {
  updateColors()
  const w = window.innerWidth

  pageHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight * 3)

  deepCtx = deepCanvas.value.getContext('2d')
  midCtx = midCanvas.value.getContext('2d')
  nearCtx = nearCanvas.value.getContext('2d')

  // 5 个光球：按深度和页面位置分布
  orbs = [
    new Orb(0.1, colors.orbs[0], 260),   // 最远
    new Orb(0.25, colors.orbs[1], 200),  // 远
    new Orb(0.4, colors.orbs[2], 150),   // 中远
    new Orb(0.6, colors.orbs[3], 120),   // 中近
    new Orb(0.8, colors.orbs[4], 90),    // 最近
  ]
  orbs[0].x = w * 0.8; orbs[0].y = pageHeight * 0.12
  orbs[1].x = w * 0.2; orbs[1].y = pageHeight * 0.3
  orbs[2].x = w * 0.6; orbs[2].y = pageHeight * 0.5
  orbs[3].x = w * 0.35; orbs[3].y = pageHeight * 0.65
  orbs[4].x = w * 0.7; orbs[4].y = pageHeight * 0.8

  deepParticles = initParticles(25, w, pageHeight)
  midParticles = initParticles(50, w, pageHeight)
  nearParticles = initParticles(60, w, pageHeight)

  targetScrollY = window.scrollY
  scrollY = targetScrollY

  animationId = requestAnimationFrame(animate)

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onResize)

  observer = new MutationObserver(() => updateColors())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
})

onUnmounted(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', onResize)
  if (observer) observer.disconnect()
})
</script>

<style scoped>
.particle {
  position: relative;
}

.particle-canvas {
  position: fixed;
  pointer-events: none;
  z-index: 0;
  top: 0;
  left: 0;
  height: 100vh;
  width: 100vw;
}
</style>
