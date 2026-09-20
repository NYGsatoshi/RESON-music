import { beforeAll } from 'vitest'
import { setProjectAnnotations } from '@storybook/nextjs-vite'
import * as a11yAnnotations from '@storybook/addon-a11y/preview'
import * as projectAnnotations from './preview'

const annotations = setProjectAnnotations([
  a11yAnnotations,
  projectAnnotations,
])

beforeAll(annotations.beforeAll)
