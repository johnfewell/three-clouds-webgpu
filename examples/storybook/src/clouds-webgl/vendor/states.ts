// Vendored from three-geospatial storybook/src/helpers/states.ts @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda) — the WebGL reference storybook.
// Verbatim.

import { atom, type SetStateAction } from 'jotai'

export const googleMapsApiKeyAtom = atom('')

export const needsApiKeyPrimitiveAtom = atom(false)
export const needsApiKeyAtom = atom(
  get => get(needsApiKeyPrimitiveAtom) && get(googleMapsApiKeyAtom) === '',
  (get, set, value: SetStateAction<boolean>) => {
    set(needsApiKeyPrimitiveAtom, value)
  }
)
