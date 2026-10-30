import browser from 'webextension-polyfill'

import { setupDownloadMessages } from './download'
import { setupLoadingMessages } from './loading'
import { setupApiMsgLstnrs } from './messageListeners/api'
import { setupTabMsgLstnrs } from './messageListeners/tabs'
import { setupPlaybackMessages } from './playback'

browser.runtime.onInstalled.addListener(async () => {
  // eslint-disable-next-line no-console
  console.log('Extension installed')
})

function isExtensionUri(url: string) {
  return new URL(url).origin === new URL(browser.runtime.getURL('')).origin
}

// eslint-disable-next-line node/prefer-global/process
if (process.env.FIREFOX) {
  browser.webRequest.onBeforeSendHeaders.addListener(
    async (details: any) => {
      const requestHeaders: browser.WebRequest.HttpHeaders = []
      if (details.documentUrl) {
        const url = new URL(details.documentUrl)
        const extensionUri = isExtensionUri(details.documentUrl)
        const isBilibili = url.hostname === 'bilibili.com' || url.hostname.endsWith('.bilibili.com')
        if (!extensionUri && !isBilibili)
          return

        details.requestHeaders = details.requestHeaders || []
        for (let i = 0; i < details.requestHeaders.length; i++) {
          const header = details.requestHeaders[i]
          const lowerName = header.name.toLowerCase()
          if (lowerName === 'origin' || lowerName === 'referer') {
            if (extensionUri)
              requestHeaders.push({ name: header.name, value: 'https://www.bilibili.com' })
            else
              requestHeaders.push(header)
          }
          else {
            requestHeaders.push(header)
          }

          if (header.name === 'firefox-multi-account-cookie') {
            requestHeaders.push({ name: 'cookie', value: header.value })
          }
        }

        return { ...details, requestHeaders }
      }
    },
    { urls: ['*://*.bilibili.com/*', '*://bilibili.com/*', '*://*.hdslb.com/*', '*://*.biliapi.net/*', '*://*.biliapi.com/*'] },
    ['blocking', 'requestHeaders'],
  )
}

// Setup all message listeners
setupApiMsgLstnrs()
setupTabMsgLstnrs()
setupDownloadMessages()
setupLoadingMessages()
setupPlaybackMessages()
