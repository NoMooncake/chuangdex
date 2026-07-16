/// <reference types="vite/client" />

import type { ChuangDexBridge } from '../../preload/index'

declare global {
  interface Window {
    chuangdex: ChuangDexBridge
  }
}

export {}
