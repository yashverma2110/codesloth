<template>
  <div class="card"><Avatar :src="user.avatar" /><span>{{ fullName }}</span></div>
</template>

<script>
import { defineComponent } from 'vue'
export default defineComponent({ name: 'UserCard' })
</script>

<script setup lang="ts">
import { computed } from 'vue'
import Avatar from './Avatar.vue'
import { useUserStore } from '@/stores/user'
import type { User } from '../types'
const AsyncChart = defineAsyncComponent(() => import('./Chart.vue'))
const props = defineProps<{ user: User }>()
const fullName = computed(() => props.user.first + ' ' + props.user.last)
// template mentions import x from './not-real' in a comment
</script>

<style scoped src="./card.css"></style>
