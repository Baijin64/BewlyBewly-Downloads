import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'

import Button from '../../../src/components/Button.vue'
import Input from '../../../src/components/Input.vue'
import Radio from '../../../src/components/Radio.vue'
import Select from '../../../src/components/Select.vue'
import Preview from './Preview.vue'

import 'uno.css'
import '../../../src/styles/reset.css'
import '../../../src/styles/variables.scss'
import '../../../src/styles/main.scss'

const app = createApp(Preview)
app.use(createPinia())
app.use(createI18n({ legacy: false, locale: 'cmn-CN', missingWarn: false, fallbackWarn: false, messages: { 'cmn-CN': { dock: { home: '首页', search: '搜索', anime: '番剧', favorites: '收藏', history: '历史', watch_later: '稍后再看', moments: '动态', downloads: '下载器', settings: '设置', dark_mode: '深色', light_mode: '浅色' }, common: { confirm: '确认', cancel: '取消' } } } }))
app.component('Button', Button)
app.component('Input', Input)
app.component('Radio', Radio)
app.component('Select', Select)
app.mount('#app')
