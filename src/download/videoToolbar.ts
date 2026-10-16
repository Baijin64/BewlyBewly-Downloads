interface ToolbarOptions {
  onDownload: () => void
  accentColor: () => string
}

/** Own only the fifth action; Bilibili keeps ownership of its four existing actions. */
export function createVideoToolbarDownload(options: ToolbarOptions, doc: Document = document) {
  let wrapper: HTMLDivElement | undefined
  let button: HTMLButtonElement | undefined

  function dispose() {
    wrapper?.remove()
    wrapper = undefined
    button = undefined
  }

  function refresh(enabled = true) {
    if (!enabled) {
      dispose()
      return
    }
    const main = doc.querySelector<HTMLElement>('#arc_toolbar_report .video-toolbar-left-main') || doc.querySelector<HTMLElement>('#arc_toolbar_report .video-toolbar-left')
    const share = main?.querySelector<HTMLElement>('.video-share-wrap, .video-share')
    const anchor = share?.closest<HTMLElement>('.toolbar-left-item-wrap') || share
    if (!main || !share || !anchor || anchor.parentElement !== main) {
      if (wrapper && !wrapper.isConnected)
        dispose()
      return
    }
    if (!wrapper || !wrapper.isConnected || wrapper.parentElement !== main) {
      dispose()
      wrapper = doc.createElement('div')
      wrapper.className = 'toolbar-left-item-wrap'
      wrapper.dataset.bewlyDownloadAction = 'true'
      const style = doc.createElement('style')
      style.textContent = '[data-bewly-download-action] .bewly-native-download{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;background:transparent;color:var(--bew-download-text)!important;font:inherit;font-size:14px;line-height:32px;cursor:pointer;white-space:nowrap}[data-bewly-download-action] .bewly-native-download:hover,[data-bewly-download-action] .bewly-native-download:focus-visible{color:var(--bew-download-accent)!important}[data-bewly-download-action] svg{width:30px;height:30px;flex-shrink:0}'
      button = doc.createElement('button')
      button.type = 'button'
      button.className = 'bewly-native-download'
      button.setAttribute('aria-label', '下载视频')
      button.title = '下载视频'
      button.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11 3a1 1 0 0 1 2 0v9.6l3.3-3.3a1 1 0 0 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 1.4-1.4l3.3 3.3V3Z"/><path d="M4 15a1 1 0 0 1 1 1v3h14v-3a1 1 0 1 1 2 0v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a1 1 0 0 1 1-1Z"/></svg><span>下载</span>'
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        options.onDownload()
      })
      wrapper.append(style, button)
      anchor.after(wrapper)
    }
    else if (wrapper.previousElementSibling !== anchor) {
      anchor.after(wrapper)
    }
    const view = doc.defaultView
    if (view) {
      const native = view.getComputedStyle(share)
      const slot = view.getComputedStyle(anchor)
      Object.assign(wrapper.style, { display: 'flex', alignItems: 'center', flexShrink: '0', marginRight: slot.marginRight, width: slot.width })
      wrapper.style.setProperty('--bew-download-text', native.color)
      wrapper.style.setProperty('--bew-download-accent', options.accentColor())
      if (button)
        button.style.fontSize = native.fontSize
    }
  }

  return { refresh, dispose }
}
