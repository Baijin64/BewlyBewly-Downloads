import type { MaybeElement } from '@vueuse/core'
import { unrefElement, useElementVisibility } from '@vueuse/core'
import type { CSSProperties, Ref } from 'vue'
import { effectScope, getCurrentScope, onScopeDispose, ref, watch } from 'vue'

interface TransformerCenter {
  x?: boolean
  y?: boolean
}

export interface Transformer {
  x: number | string
  y: number | string
  centerTarget?: TransformerCenter
  notrigger?: boolean
}

const transformerCleanups = new WeakMap<object, () => void>()

export function cleanTransformer(target: object) {
  const cleanup = transformerCleanups.get(target)
  if (cleanup) {
    cleanup()
    transformerCleanups.delete(target)
  }
}

/**
 * Covert transform to top and left style, if no chromium, use transform
 * @param trigger
 * @param transformer
 */
export function createTransformer(trigger: Ref<MaybeElement>, transformer: Transformer) {
  if (trigger && typeof trigger === 'object') {
    const prevCleanup = transformerCleanups.get(trigger)
    if (prevCleanup) {
      prevCleanup()
      transformerCleanups.delete(trigger)
    }
  }

  const rawElement = unrefElement(trigger)
  if (rawElement && typeof rawElement === 'object') {
    const prevElCleanup = transformerCleanups.get(rawElement)
    if (prevElCleanup) {
      prevElCleanup()
      transformerCleanups.delete(rawElement)
    }
  }

  const target = ref<MaybeElement>()
  const style = ref<CSSProperties>({})

  function update() {
    let x = '0px'
    let y = '0px'

    if (typeof transformer.x === 'number') {
      x = `${transformer.x}px`
    }
    else {
      x = transformer.x
    }

    if (typeof transformer.y === 'number') {
      y = `${transformer.y}px`
    }
    else {
      y = transformer.y
    }

    if (target.value && transformer.centerTarget) {
      const el = unrefElement(target.value)
      const targetRect = el!.getBoundingClientRect()

      if (transformer.centerTarget.x) {
        x = `calc(${transformer.x} - ${targetRect.width / 2}px)`
      }

      if (transformer.centerTarget.y) {
        y = `calc(${transformer.y} - ${targetRect.height / 2}px)`
      }
    }

    style.value = {
      transform: 'none !important',
      top: y,
      left: x,
    }

    //   // nothing, use inherit transform
    //   style.value = {
    //     transform: `translate3d(${x}, ${y}, 0) !important`,
    //   }
  }

  function generateStyle(originStyle: string | undefined | null): string {
    const s = (originStyle || '')
      .split(';')
      .map((item) => {
        const [key, value] = item.split(':').map(item => item.trim())

        if (!key || !value) {
          return {}
        }

        return {
          [key]: value,
        }
      })
      .reduce((acc, item) => {
        return {
          ...acc,
          ...item,
        }
      }, {})

    for (const key in style.value) {
      // @ts-expect-error ignore
      s[key] = style.value[key]
    }

    return Object.keys(s).map(key => `${key}:${s[key]}`).join(';')
  }

  const scope = effectScope()
  let stopTrigger: (() => void) | undefined
  let stopVisibility: (() => void) | undefined
  let stopTarget: (() => void) | undefined

  scope.run(() => {
    stopTrigger = watch(trigger, () => {
      if (transformer.notrigger) {
        target.value = unrefElement(trigger)
      }
    }, { immediate: true })

    // v-show
    const targetVisibility = useElementVisibility(() => unrefElement(target))
    stopVisibility = watch(targetVisibility, (visible) => {
      if (visible) {
        const targetElement = unrefElement(target)
        if (targetElement) {
          update()
          const style = targetElement.getAttribute('style')
          targetElement.setAttribute('style', generateStyle(style))
        }
      }
    }, { flush: 'pre' })

    // v-if
    stopTarget = watch(() => unrefElement(target), (targetElement) => {
      if (targetElement) {
        update()
        const style = targetElement.getAttribute('style')
        targetElement.setAttribute('style', generateStyle(style))
      }
    }, { flush: 'pre' })
  })

  const cleanup = () => {
    stopTrigger?.()
    stopVisibility?.()
    stopTarget?.()
    scope.stop()
  }

  if (trigger && typeof trigger === 'object')
    transformerCleanups.set(trigger, cleanup)

  if (rawElement && typeof rawElement === 'object')
    transformerCleanups.set(rawElement, cleanup)

  if (getCurrentScope()) {
    onScopeDispose(() => {
      cleanup()
      if (trigger && typeof trigger === 'object')
        transformerCleanups.delete(trigger)
      if (rawElement && typeof rawElement === 'object')
        transformerCleanups.delete(rawElement)
    })
  }

  return target
}
