import { createApp, defineComponent, h } from 'vue'
import { createPinia } from 'pinia'

import Button from '../../../src/components/Button.vue'
import Input from '../../../src/components/Input.vue'
import Radio from '../../../src/components/Radio.vue'
import Select from '../../../src/components/Select.vue'
import ALink from '../../../src/components/ALink.vue'
import Picture from '../../../src/components/Picture.vue'
import Tooltip from '../../../src/components/Tooltip.vue'
import Loading from '../../../src/components/Loading.vue'
import Empty from '../../../src/components/Empty.vue'
import VideoCard from '../../../src/components/VideoCard/VideoCard.vue'
import Toast from 'vue-toastification'
import Preview from './Preview.vue'
import { i18n } from '../../../src/utils/i18n'

import 'uno.css'
import '../../../src/styles/reset.css'
import '../../../src/styles/variables.scss'
import '../../../src/styles/main.scss'

const app = createApp(Preview)
app.use(createPinia())
app.use(Toast)
i18n.global.locale.value = 'cmn-CN'
app.use(i18n)
app.component('Button', Button)
app.component('Input', Input)
app.component('Radio', Radio)
app.component('Select', Select)
app.component('ALink', ALink)
// The production page is HTTPS; the local HTTP harness must keep CDN images HTTPS.
app.component('Picture', defineComponent({
  inheritAttrs: false,
  props: ['src', 'loading', 'alt'],
  setup: (props, { attrs }) => () => h(Picture, { ...attrs, ...props, src: props.src?.replace(/^\/\//, 'https://') }),
}))
app.component('Tooltip', Tooltip)
app.component('Loading', Loading)
app.component('Empty', Empty)
app.component('VideoCard', VideoCard)
app.mount('#app')
