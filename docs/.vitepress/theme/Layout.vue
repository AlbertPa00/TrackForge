<script setup lang="ts">
import DefaultTheme from 'vitepress/theme';
import HomeExtra from './components/HomeExtra.vue';
</script>

<template>
  <DefaultTheme.Layout>
    <template #home-features-after>
      <HomeExtra />
    </template>
  </DefaultTheme.Layout>
</template>
