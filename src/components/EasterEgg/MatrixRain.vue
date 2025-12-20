<script setup lang="ts">
/**
 * Matrix 数字雨彩蛋组件
 * 特效：ASCII艺术字随雨滴流淌逐渐显现
 */
import { ref, onMounted, onUnmounted } from 'vue'

const emit = defineEmits<{
  close: []
}>()

// ====================== 配置项 ======================
const CONFIG = {
  // 时间设置（毫秒）
  revealStart: 0,         // 文字开始显示的时间
  frameInterval: 33,      // 帧间隔（33 ≈ 30fps）
  clickableDelay: 5000,   // 多久后允许点击退出
  
  // 雨滴设置
  fontSize: 16,           // 雨滴字体大小
  fadeAlpha: 0.05,        // 拖尾透明度（越小拖尾越长）
  resetChance: 0.975,     // 雨滴重置概率（越大重置越慢）
  
  // 文字显示设置
  revealSpeed: 0.12,      // 文字揭示速度（越大越快）
}
// ====================================================

const canvasRef = ref<HTMLCanvasElement | null>(null)
let animationId: number | null = null
const canClickToClose = ref(false)  // 文字完全显示后才允许点击退出

// 点击退出
const handleClick = () => {
  if (canClickToClose.value) {
    if (animationId) clearInterval(animationId)
    emit('close')
  }
}

// Matrix 字符集
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%^&*()_+-=[]{}|;:,.<>?'

// ASCII 艺术字（空心风格）- SFTerm
const ASCII_ART_EN = [
  ' _____ _____ _____                     ',
  '/  ___|  ___|_   _|                    ',
  '\\ `--.| |_    | | ___ _ __ _ __ ___   ',
  ' `--. \\  _|   | |/ _ \\ \'__| \'_ ` _ \\  ',
  '/\\__/ / |     | |  __/ |  | | | | | | ',
  '\\____/\\_|     \\_/\\___|_|  |_| |_| |_| ',
]

// 中文标题（单独绘制，更大字体）
const TITLE_CN = '「  旗  鱼  终  端  」'

const initMatrix = () => {
  const canvas = canvasRef.value
  if (!canvas) return

  const ctx = canvas.getContext('2d')
  if (!ctx) return

  canvas.width = window.innerWidth
  canvas.height = window.innerHeight

  const { fontSize, fadeAlpha, resetChance, revealStart, revealSpeed } = CONFIG
  const columns = Math.floor(canvas.width / fontSize)

  // 雨滴从屏幕上方开始，错落下落
  const drops: number[] = []
  for (let i = 0; i < columns; i++) {
    // 随机分散在屏幕上方，避免同时出现
    drops[i] = Math.floor(Math.random() * -50) - 10
  }

  // 创建离屏 canvas 绘制 ASCII 艺术字
  const textCanvas = document.createElement('canvas')
  textCanvas.width = canvas.width
  textCanvas.height = canvas.height
  const textCtx = textCanvas.getContext('2d')!
  
  // ASCII 艺术字的字体大小（根据屏幕宽度自适应）
  const artFontSize = Math.max(18, Math.min(28, Math.floor(canvas.width / 42)))
  const lineHeight = artFontSize * 1.2
  
  // 中文字体大小（比英文大）
  const cnFontSize = Math.max(40, Math.min(72, Math.floor(canvas.width / 18)))
  
  textCtx.fillStyle = '#fff'
  textCtx.textAlign = 'center'
  textCtx.textBaseline = 'middle'
  
  // 计算总高度（英文 + 间距 + 中文）
  const enHeight = ASCII_ART_EN.length * lineHeight
  const gap = cnFontSize * 0.8
  const totalHeight = enHeight + gap + cnFontSize
  const startY = (canvas.height - totalHeight) / 2
  
  // 绘制英文 ASCII 艺术字
  textCtx.font = `bold ${artFontSize}px "SF Mono", "Consolas", "Monaco", monospace`
  ASCII_ART_EN.forEach((line, index) => {
    const y = startY + index * lineHeight + lineHeight / 2
    textCtx.fillText(line, canvas.width / 2, y)
  })
  
  // 绘制中文标题（更大字体）
  textCtx.font = `bold ${cnFontSize}px "PingFang SC", "Microsoft YaHei", sans-serif`
  const cnY = startY + enHeight + gap + cnFontSize / 2
  textCtx.fillText(TITLE_CN, canvas.width / 2, cnY)
  
  // 获取文字像素数据
  const textImageData = textCtx.getImageData(0, 0, canvas.width, canvas.height)
  const textPixels = textImageData.data

  // 显示蒙版
  const revealMask = new Float32Array(canvas.width * canvas.height)

  const startTime = Date.now()

  const draw = () => {
    const elapsed = Date.now() - startTime
    const canReveal = elapsed > revealStart
    
    // 一定时间后允许点击退出
    if (elapsed > CONFIG.clickableDelay && !canClickToClose.value) {
      canClickToClose.value = true
    }

    // 半透明黑色覆盖
    ctx.fillStyle = `rgba(0, 0, 0, ${fadeAlpha})`
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // 绿色雨滴
    ctx.fillStyle = '#0F0'
    ctx.font = `${fontSize}px monospace`
    ctx.shadowBlur = 0

    for (let i = 0; i < drops.length; i++) {
      const char = chars[Math.floor(Math.random() * chars.length)]
      const x = i * fontSize
      const y = drops[i] * fontSize
      
      ctx.fillText(char, x, y)

      // 更新蒙版
      if (canReveal && y > 0 && y < canvas.height) {
        for (let dy = -fontSize; dy <= fontSize; dy++) {
          for (let dx = 0; dx < fontSize; dx++) {
            const px = Math.floor(x + dx)
            const py = Math.floor(y + dy)
            if (px >= 0 && px < canvas.width && py >= 0 && py < canvas.height) {
              const idx = py * canvas.width + px
              revealMask[idx] = Math.min(1, revealMask[idx] + revealSpeed)
            }
          }
        }
      }

      drops[i]++

      if (drops[i] * fontSize > canvas.height && Math.random() > resetChance) {
        drops[i] = 0
      }
    }

    // 绘制被雨滴揭示的文字（绿色，与雨滴融合）
    if (canReveal) {
      const outputData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const output = outputData.data

      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const idx = y * canvas.width + x
          const pixelIdx = idx * 4
          
          const textAlpha = textPixels[pixelIdx + 3]
          if (textAlpha > 0) {
            const reveal = revealMask[idx]
            if (reveal > 0) {
              const intensity = reveal * (textAlpha / 255)
              
              // 纯绿色发光效果（加法混合，但有最大值限制）
              const green = 255 * intensity
              
              // 限制最大值：R/B 最高25，G 最高255（保持纯绿色）
              output[pixelIdx] = Math.min(25, output[pixelIdx] + green * 0.1)       // R - 极少
              output[pixelIdx + 1] = Math.min(255, output[pixelIdx + 1] + green)    // G - 纯绿
              output[pixelIdx + 2] = Math.min(25, output[pixelIdx + 2] + green * 0.1) // B - 极少
            }
          }
        }
      }

      ctx.putImageData(outputData, 0, 0)
    }
  }

  const intervalId = setInterval(draw, CONFIG.frameInterval)
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
  window.removeEventListener('resize', handleResize)
})
</script>

<template>
  <Teleport to="body">
    <div class="matrix-overlay" @click="handleClick" :class="{ clickable: canClickToClose }">
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

.matrix-overlay.clickable {
  cursor: pointer;
}

.matrix-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
