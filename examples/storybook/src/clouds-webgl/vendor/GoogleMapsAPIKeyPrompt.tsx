// Vendored from three-geospatial storybook/src/helpers/GoogleMapsAPIKeyPrompt.tsx @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda) — the WebGL reference storybook.
// Edited: the emotion `css` prop became a plain `style` (no emotion babel
// plugin here).

import { useAtomValue } from 'jotai'
import type { FC } from 'react'

import { needsApiKeyAtom } from './states'

export const GoogleMapsAPIKeyPrompt: FC = () => {
  const needsApiKey = useAtomValue(needsApiKeyAtom)
  return (
    needsApiKey && (
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          color: 'white',
          textAlign: 'center',
          lineHeight: 1.5,
          transform: 'translate(-50%, -50%)'
        }}
      >
        Our API key has seemingly exceeded its daily quota.
        <br />
        Enter your{' '}
        <a
          href='https://developers.google.com/maps/documentation/tile/get-api-key'
          target='_blank'
          rel='noreferrer'
          style={{ color: 'inherit' }}
        >
          Google Maps API key
        </a>{' '}
        at the top right of this screen, or check back tomorrow.
      </div>
    )
  )
}
