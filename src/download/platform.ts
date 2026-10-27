export type HelperPlatform = 'win' | 'mac' | 'linux' | 'other'

let cached: HelperPlatform | undefined

export function helperPlatform(): HelperPlatform {
  if (cached)
    return cached
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Windows/i.test(agent))
    cached = 'win'
  else if (/Macintosh|Mac OS X/i.test(agent))
    cached = 'mac'
  else if (/Linux|X11/i.test(agent) && !/Android/i.test(agent))
    cached = 'linux'
  else cached = 'other'
  return cached
}

export function helperInstallHint(): string {
  switch (helperPlatform()) {
    case 'win': return '请先安装 Bewly 下载助手，并从开始菜单打开一次完成浏览器连接。然后点击重试。'
    case 'mac': return '请先打开「Bewly 下载助手」完成连接（首次需在系统设置中允许打开），然后点击重试。'
    case 'linux': return '请先运行下载助手的 install.sh 并重启浏览器，然后点击重试。'
    default: return '请先安装 Bewly 下载助手并打开一次完成浏览器连接。'
  }
}

export function helperStartHint(): string {
  switch (helperPlatform()) {
    case 'win': return '请从开始菜单打开下载助手，完成运行环境准备后重试。'
    default: return '请打开 Bewly 下载助手完成初始化后重试。'
  }
}

export function helperUpdateHint(): string {
  switch (helperPlatform()) {
    case 'win': return '按需启动需要下载助手 0.2.8 或更新版本，请更新 MSIX。'
    default: return '按需启动需要下载助手 0.2.8 或更新版本，请更新下载助手。'
  }
}
