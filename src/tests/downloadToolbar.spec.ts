import { afterEach, expect, it, vi } from 'vitest'

import { createVideoToolbarDownload } from '~/download/videoToolbar'

function videoToolbar() {
  document.body.innerHTML = '<div id="arc_toolbar_report"><div class="video-toolbar-left"><div class="video-toolbar-left-main"><div class="toolbar-left-item-wrap"><button>点赞</button></div><div class="toolbar-left-item-wrap"><button>投币</button></div><div class="toolbar-left-item-wrap"><button>收藏</button></div><div class="toolbar-left-item-wrap"><div class="video-share-wrap">分享</div></div></div></div></div>'
  return document.querySelector('.video-toolbar-left-main')!
}

afterEach(() => {
  document.body.innerHTML = ''
})

it('adds download immediately after share without changing native actions', () => {
  const main = videoToolbar()
  const download = vi.fn()
  const toolbar = createVideoToolbarDownload({ onDownload: download, accentColor: () => '#00a1d6' })
  toolbar.refresh()
  toolbar.refresh()
  expect(main.children).toHaveLength(5)
  expect(main.children[3].textContent).toBe('分享')
  const button = main.children[4].querySelector('button')!
  expect(button.textContent).toBe('下载')
  button.click()
  expect(download).toHaveBeenCalledOnce()
  toolbar.dispose()
  expect(main.children).toHaveLength(4)
})

it('reattaches once after SPA replaces the native toolbar and removes only its own slot', () => {
  videoToolbar()
  const toolbar = createVideoToolbarDownload({ onDownload: () => {}, accentColor: () => '#00a1d6' })
  toolbar.refresh()
  const main = videoToolbar()
  toolbar.refresh()
  expect(main.children).toHaveLength(5)
  toolbar.refresh(false)
  expect(main.children).toHaveLength(4)
  expect(document.querySelector('[data-bewly-download-action]')).toBeNull()
})
