// Vendored from three-geospatial storybook-webgpu/src/helpers/StoryContext.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Verbatim.

import type { Args } from '@storybook/react-vite'
import { atom, type PrimitiveAtom } from 'jotai'
import { createContext } from 'react'

export interface StoryContextValue {
  argsAtom: PrimitiveAtom<Args>
  updateArgs?: (newArgs: Partial<Args>) => void
}

export const StoryContext = createContext<StoryContextValue>({
  argsAtom: atom({})
})
