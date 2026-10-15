import { describe, expect, test } from 'bun:test'

import { SceneGraph } from '../src'
import {
  clearInstanceOverrides,
  cloneInstanceOverrideState,
  createInstanceOverrideState,
  deleteInstanceOverride,
  deserializeInstanceOverrideState,
  ensureInstanceOverrideState,
  getInstanceOverride,
  hasInstanceOverride,
  serializeInstanceOverrideState,
  setInstanceOverride
} from '../src/instance-overrides'

describe('instance override state', () => {
  test('stores self and descendant values structurally', () => {
    const state = createInstanceOverrideState()
    setInstanceOverride(state, 'instance', 'instance', 'visible', false)
    setInstanceOverride(state, 'instance', 'child', 'text', 'Custom')
    expect(getInstanceOverride(state, 'instance', 'instance', 'visible')).toBe(false)
    expect(getInstanceOverride(state, 'instance', 'child', 'text')).toBe('Custom')
    expect(hasInstanceOverride(state, 'instance', 'child', 'text')).toBe(true)
  })

  test('reports presence for an explicit undefined override', () => {
    const state = createInstanceOverrideState()
    setInstanceOverride(state, 'instance', 'child', 'visible', undefined)
    expect(hasInstanceOverride(state, 'instance', 'child', 'visible')).toBe(true)
  })

  test('round-trips explicit undefined values through JSON', () => {
    const state = createInstanceOverrideState()
    state.self.set('opacity', undefined)
    state.descendants.set('child', new Map([['visible', undefined]]))
    // eslint-disable-next-line unicorn/prefer-structured-clone -- exercise the JSON boundary
    const serialized: unknown = JSON.parse(JSON.stringify(serializeInstanceOverrideState(state)))
    const restored = deserializeInstanceOverrideState(serialized)

    expect(hasInstanceOverride(restored, 'instance', 'instance', 'opacity')).toBe(true)
    expect(getInstanceOverride(restored, 'instance', 'instance', 'opacity')).toBeUndefined()
    expect(hasInstanceOverride(restored, 'instance', 'child', 'visible')).toBe(true)
    expect(getInstanceOverride(restored, 'instance', 'child', 'visible')).toBeUndefined()
  })

  test('ignores malformed serialized entries', () => {
    const state = deserializeInstanceOverrideState({ self: [null], descendants: [] })
    expect(state.self.size).toBe(0)
    expect(state.descendants.size).toBe(0)
  })

  test('deletes empty descendant buckets', () => {
    const state = createInstanceOverrideState()
    setInstanceOverride(state, 'instance', 'child', 'text')
    expect(deleteInstanceOverride(state, 'instance', 'child', 'text')).toBe(true)
    expect(state.descendants.has('child')).toBe(false)
  })

  test('accepts plain objects and keeps an existing map', () => {
    const plain = ensureInstanceOverrideState({
      self: { opacity: 0.4 },
      descendants: { child: { text: 'Custom' } }
    })
    expect(plain.self).toBeInstanceOf(Map)
    expect(plain.descendants).toBeInstanceOf(Map)
    expect(getInstanceOverride(plain, 'instance', 'instance', 'opacity')).toBe(0.4)
    expect(getInstanceOverride(plain, 'instance', 'child', 'text')).toBe('Custom')

    const ready = createInstanceOverrideState()
    expect(ensureInstanceOverrideState(ready)).toBe(ready)
  })

  test('syncInstances reads a plain-object self map', () => {
    const graph = new SceneGraph()
    const page = graph.getPages()[0]
    if (!page) throw new Error('missing page')
    const component = graph.createNode('COMPONENT', page.id, {
      name: 'Card',
      width: 40,
      height: 20,
      opacity: 1
    })
    const instance = graph.createInstance(component.id, page.id)
    if (!instance) throw new Error('missing instance')
    instance.instanceOverrides = {
      self: { opacity: 0.4 },
      descendants: {}
    } as typeof instance.instanceOverrides
    graph.updateNode(component.id, { opacity: 0.2 })

    graph.syncInstances(component.id)

    expect(instance.instanceOverrides.self).toBeInstanceOf(Map)
    expect(
      getInstanceOverride(instance.instanceOverrides, instance.id, instance.id, 'opacity')
    ).toBe(0.4)
    expect(instance.opacity).toBe(1)
  })

  test('clones independently and clears', () => {
    const state = createInstanceOverrideState()
    setInstanceOverride(state, 'instance', 'child', 'text', 'Custom')
    const clone = cloneInstanceOverrideState(state)
    setInstanceOverride(clone, 'instance', 'child', 'text', 'Other')
    expect(getInstanceOverride(state, 'instance', 'child', 'text')).toBe('Custom')
    clearInstanceOverrides(state)
    expect(state.descendants.size).toBe(0)
  })
})
