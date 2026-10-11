import type { Router } from 'vue-router'

import { homeLocation, type HomeLocation } from '@/app/home/location'

/** Shows Home at one of its places, in a new tab when a document is open. */
export function openHomeLocation(router: Router, location: HomeLocation): void {
  homeLocation.value = location
  void router
    .push('/')
    .then(() => import('@/app/tabs'))
    .then(({ showNewTab }) => showNewTab())
}

export function openStorageWorkspace(router: Router): void {
  openHomeLocation(router, { kind: 'storage' })
}
