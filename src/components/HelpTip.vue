<script setup lang="ts">
// 问号帮助提示：hover/focus 时展示多行说明（纯 CSS，无 JS 状态）
defineProps<{
  /** 说明文本，\n 换行 */
  text: string;
  /** 标题（可选），展示在说明上方加粗 */
  title?: string;
}>();
</script>

<template>
  <span class="help-tip" tabindex="0" aria-label="详细说明">
    ?
    <span class="ht-tip" role="tooltip">
      <b v-if="title" class="ht-title">{{ title }}</b>
      <span class="ht-body">{{ text }}</span>
    </span>
  </span>
</template>
