<script lang="ts" setup>
const props = defineProps<{
  label?: string
  ariaLabel?: string
  disabled?: boolean
}>()

const model = defineModel<boolean>({ required: true })
function toggle() {
  if (!props.disabled)
    model.value = !model.value
}
</script>

<template>
  <label
    cursor="pointer" pointer="auto" flex items-center gap-3
    role="switch" :aria-label="ariaLabel || label" :aria-checked="model" :aria-disabled="disabled || undefined"
    :tabindex="disabled ? -1 : 0" :class="{ 'is-disabled': disabled }"
    @click.prevent="toggle"
    @keydown.space.stop.prevent="toggle" @keydown.enter.stop.prevent="toggle"
  >
    <span v-if="label">{{ label }}</span>
    <input
      :checked="model" type="checkbox" hidden :disabled="disabled" tabindex="-1"
      aria-hidden="true"
    >
    <span
      inline-block w="$b-button-width" h="$b-button-height" bg="$bew-fill-1" rounded="[calc(var(--b-button-height)/2)]"
      relative border="size-$b-border-width color-$bew-border-color"
      after:content-empty after:inline-block after:bg-white after:rounded="[calc(var(--b-button-height)/2)]"
      after:w="[calc(var(--b-button-height)-var(--b-border-width))]" after:h="[calc(var(--b-button-height)-var(--b-border-width))]"
      after:border="size-$b-border-width color-$bew-border-color"
      after:pos="absolute top-[calc(0px-var(--b-border-width)/2)]"
    />
  </label>
</template>

<style lang="scss" scoped>
label {
  --b-button-width: 50px;
  --b-button-height: 25px;
  --b-border-width: 2px;
}
label:focus-visible {
  outline: 2px solid var(--bew-theme-color);
  outline-offset: 4px;
  border-radius: 50px;
}
label.is-disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

input[type="checkbox"] + span::after {
  box-sizing: border-box;
}

input[type="checkbox"] {
  &:hover + span {
    --uno: "bg-$bew-fill-2";
  }

  &:active + span::after {
    --uno: "scale-90";
  }

  &:checked + span {
    --uno: "bg-$bew-theme-color-60 border-$bew-theme-color";
  }

  &:checked:hover + span {
    --uno: "bg-$bew-theme-color-80 border-$bew-theme-color";
    box-shadow:
      0 0 6px 2px var(--bew-theme-color-40),
      inset 0 0 6px var(--bew-theme-color-30);
  }

  & + span,
  & + span::after {
    transition: 0.3s cubic-bezier(0.25, 0.15, 0.29, 1.51);
  }

  &:checked + span::after {
    --uno: "border-$bew-theme-color translate-x-full";
  }
}
</style>
