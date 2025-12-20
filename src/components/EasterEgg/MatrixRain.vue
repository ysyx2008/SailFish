<script setup lang="ts">
/**
 * Matrix 数字雨彩蛋组件
 * 经典实现方式：半透明黑色叠加 + 单字符绘制
 */
import { ref, onMounted, onUnmounted } from 'vue'

const emit = defineEmits<{
  close: []
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationId: number | null = null
let autoCloseTimer: number | null = null

// Matrix 字符集（半角片假名效果最接近原版，但你说不用日文，所以用符号）
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()_+-=[]{}|;:,.<>?'

const initMatrix = () => {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  // 全屏
  canvas.width = window.innerWidth
  canvas.height = window.innerHeight

  const fontSize = 16
  const columns = Math.floor(canvas.width / fontSize)

  // 每列的 Y 坐标（以字符为单位）
  const drops: number[] = []
  for (let i = 0; i < columns; i++) {
    drops[i] = Math.floor(Math.random() * -20)  // 随机负值，让开始时错落
  }

  const draw = () => {
    // 关键：用半透明黑色覆盖，产生拖尾渐隐效果
    ctx.fillStyle = 'rgba(0, 0, 0, 0.05)'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // 绿色字符
    ctx.fillStyle = '#0F0'
    ctx.font = `${fontSize}px monospace`

    for (let i = 0; i < drops.length; i++) {
      // 随机字符
      const char = chars[Math.floor(Math.random() * chars.length)]
      
      // 绘制字符
      const x = i * fontSize
      const y = drops[i] * fontSize
      
      ctx.fillText(char, x, y)

      // 向下移动
      drops[i]++

      // 超出屏幕后，有一定概率重置到顶部
      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0
      }
    }
  }

  // 使用 setInterval 控制帧率，更接近原版的速度感
  const intervalId = setInterval(draw, 33)  // 约 30fps

  // 10 秒后自动关闭
  autoCloseTimer = window.setTimeout(() => {
    clearInterval(intervalId)
    emit('close')
  }, 10000)

  // 保存清理函数
  animationId = intervalId as unknown as number
}

const handleResize = () => {
  const canvas = canvasRef.value
  if (canvas) {
    canvas.width = window.innerWidth
    canvas.height = window.innerHeight
  }
}

onMounted(() => {
  initMatrix()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  if (animationId) {
    clearInterval(animationId)
  }
  if (autoCloseTimer) {
    clearTimeout(autoCloseTimer)
  }
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <Teleport to="body">
    <div class="matrix-overlay">
      <canvas ref="canvasRef" class="matrix-canvas"></canvas>
    </div>
  </Teleport>
</template>

<style scoped>
.matrix-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 99999;
  background: #000;
}

.matrix-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
