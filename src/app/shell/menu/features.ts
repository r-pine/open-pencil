import { computed, watch } from 'vue'

import { cloudAvailable } from '@/app/cloud/availability'
import { isTauri } from '@/app/tauri/env'

import type { AppMenuFeature } from './schema'

const available: Record<AppMenuFeature, () => boolean> = {
  cloud: () => cloudAvailable.value
}

/** Whether a menu item that waits for a feature shows; items without one always do. */
export function menuFeatureAvailable(feature: AppMenuFeature | undefined): boolean {
  return feature === undefined || available[feature]()
}

const availableFeatures = computed(() =>
  (Object.keys(available) as AppMenuFeature[]).filter((feature) => available[feature]())
)

/** Keeps the desktop menu's feature items in step: it builds them only once told they're on. */
export function watchNativeMenuFeatures(): () => void {
  return watch(
    availableFeatures,
    (features) => {
      if (!isTauri()) return
      void import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('set_native_menu_features', { features }))
        .catch((error: unknown) => {
          console.warn('[Menu] Failed to update the native menu', error)
        })
    },
    { immediate: true }
  )
}
