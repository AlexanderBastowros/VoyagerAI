import type { VoyagerApi } from './api'

declare global {
  interface Window {
    voyager: VoyagerApi
  }
}

export {}
