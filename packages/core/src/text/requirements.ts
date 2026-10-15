import type { SceneGraph, SceneNode } from '@open-pencil/scene-graph'

import { DEFAULT_FONT_FAMILY } from '#core/constants'
import { MAIN_THREAD_SLICE_MS, nowMs, yieldToMainThread } from '#core/editor/main-thread'
import { shownCharacters } from '#core/text/case'
import { cjkFallbackScriptForLanguage, type FontFallbackScript } from '#core/text/fallbacks'
import { weightToStyle } from '#core/text/font/style'

export function collectNodeFontFaces(node: SceneNode): Array<{ family: string; style: string }> {
  if (node.type !== 'TEXT') return []
  const family = node.fontFamily || DEFAULT_FONT_FAMILY
  const faces = new Map<string, { family: string; style: string }>()
  const add = (faceFamily: string, style: string) => {
    faces.set(`${faceFamily}\0${style}`, { family: faceFamily, style })
  }
  add(family, weightToStyle(node.fontWeight || 400, node.italic))
  for (const run of node.styleRuns) {
    const runFamily = run.style.fontFamily ?? family
    const weight = run.style.fontWeight ?? node.fontWeight
    const italic = run.style.italic ?? node.italic
    add(runFamily, weightToStyle(weight, italic))
  }
  return [...faces.values()]
}

export function collectGraphFontKeys(
  graph: SceneGraph,
  nodeIds: readonly string[]
): Array<[string, string]> {
  const fontKeys = new Set<string>()
  const collect = (nodeId: string) => {
    const node = graph.getNode(nodeId)
    if (!node) return
    if (node.type === 'TEXT') {
      for (const { family, style } of collectNodeFontFaces(node)) {
        fontKeys.add(`${family}\0${style}`)
      }
    }
    for (const childId of node.childIds) collect(childId)
  }
  for (const nodeId of nodeIds) collect(nodeId)
  return Array.from(fontKeys, (key) => key.split('\0') as [string, string])
}

function fallbackScriptForCharacter(
  character: string,
  language?: string | null
): FontFallbackScript | null {
  if (/\p{Script=Arabic}/u.test(character)) return 'arabic'
  if (/\p{Script=Hangul}/u.test(character)) return 'cjk-kr'
  if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(character)) return 'cjk-jp'
  if (/\p{Script=Han}/u.test(character)) return cjkFallbackScriptForLanguage(language) ?? 'cjk-sc'
  return null
}

function textLanguageAt(node: SceneNode, index: number): string | null {
  const run = node.styleRuns.find((item) => index >= item.start && index < item.start + item.length)
  return run?.style.textLanguage ?? node.textLanguage
}

export interface GraphFontRequirements {
  characters: string
  nodes: SceneNode[]
  scripts: FontFallbackScript[]
}

export interface CooperativeFontRequirements extends GraphFontRequirements {
  fontKeys: Array<[string, string]>
}

export function collectGraphFontRequirements(
  graph: SceneGraph,
  nodeIds: readonly string[]
): GraphFontRequirements {
  const characters = new Set<string>()
  const nodes: SceneNode[] = []
  const scripts = new Set<FontFallbackScript>()
  const collect = (nodeId: string) => {
    const node = graph.getNode(nodeId)
    if (!node) return
    nodes.push(node)
    if (node.type === 'TEXT') {
      for (const { character, sourceIndex } of shownCharacters(node)) {
        characters.add(character)
        const script = fallbackScriptForCharacter(character, textLanguageAt(node, sourceIndex))
        if (script) scripts.add(script)
      }
    }
    for (const childId of node.childIds) collect(childId)
  }
  for (const nodeId of nodeIds) collect(nodeId)
  return { characters: Array.from(characters).join(''), nodes, scripts: Array.from(scripts) }
}

/**
 * The same requirements as `collectGraphFontRequirements`, returning to the event loop while a
 * large page is scanned. Null when `shouldContinue` fails, so a newer page switch can abandon it.
 */
export async function collectGraphFontRequirementsCooperatively(
  graph: SceneGraph,
  nodeIds: readonly string[],
  shouldContinue: () => boolean = () => true
): Promise<CooperativeFontRequirements | null> {
  const characters = new Set<string>()
  const nodes: SceneNode[] = []
  const scripts = new Set<FontFallbackScript>()
  const fontKeys = new Set<string>()
  const stack = [...nodeIds].reverse()
  let scanned = 0
  let slice = nowMs()
  while (stack.length > 0) {
    const nodeId = stack.pop()
    if (!nodeId) continue
    const node = graph.getNode(nodeId)
    if (!node) continue
    nodes.push(node)
    if (node.type === 'TEXT') {
      for (const { family, style } of collectNodeFontFaces(node)) {
        fontKeys.add(`${family}\0${style}`)
      }
      for (const { character, sourceIndex } of shownCharacters(node)) {
        characters.add(character)
        const script = fallbackScriptForCharacter(character, textLanguageAt(node, sourceIndex))
        if (script) scripts.add(script)
      }
    }
    for (let index = node.childIds.length - 1; index >= 0; index--) {
      const childId = node.childIds[index]
      if (childId) stack.push(childId)
    }
    scanned++
    if (scanned % 400 === 0 && nowMs() - slice >= MAIN_THREAD_SLICE_MS) {
      if (!shouldContinue()) return null
      await yieldToMainThread()
      if (!shouldContinue()) return null
      slice = nowMs()
    }
  }
  return {
    characters: Array.from(characters).join(''),
    nodes,
    scripts: Array.from(scripts),
    fontKeys: Array.from(fontKeys, (key) => key.split('\0') as [string, string])
  }
}
