import { noop, useAsyncState } from '@vueuse/core'
import { computed, shallowRef } from 'vue'

import { usePortalFailureMessages } from './failure'

/**
 * Something the page reads from the server. A newer load replaces an older one still running,
 * a failure is kept in words until the next load starts, and the last good value stays shown.
 */
export function usePortalLoad<T>(load: () => Promise<T>, initial: T) {
  const failures = usePortalFailureMessages()
  const { state, isLoading, error, execute } = useAsyncState(load, initial, {
    resetOnExecute: false,
    onError: noop
  })
  return {
    data: state,
    loading: isLoading,
    error: computed(() => (error.value === undefined ? null : failures.api(error.value))),
    reload: async () => {
      await execute()
    }
  }
}

/**
 * A change the page makes. `busy` is true while it runs and `subject` names what it runs on, its
 * first argument; a thrown failure is put in words, and `fail` reports one the change found itself.
 * Each run clears the previous failure, and so does `clear`.
 */
export function usePortalAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<unknown>
) {
  const failures = usePortalFailureMessages()
  const subject = shallowRef<Args[0] | null>(null)
  const reported = shallowRef<string | null>(null)
  const { isLoading, error, execute } = useAsyncState(
    (...args: Args) => {
      subject.value = args[0] ?? null
      reported.value = null
      return action(...args)
    },
    undefined,
    { immediate: false, onError: noop }
  )
  return {
    busy: isLoading,
    subject: computed(() => (isLoading.value ? subject.value : null)),
    error: computed(
      () => reported.value ?? (error.value === undefined ? null : failures.api(error.value))
    ),
    run: async (...args: Args) => {
      await execute(0, ...args)
    },
    fail(message: string) {
      reported.value = message
    },
    clear() {
      reported.value = null
      error.value = undefined
    }
  }
}
