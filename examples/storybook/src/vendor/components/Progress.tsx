// Vendored from three-geospatial storybook-webgpu/src/components/Progress.tsx @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda).
// Edited: antd's circular Progress replaced with a CSS conic-gradient ring
// (antd is not a dependency here). Same placement, same fade, same colours.

import styled from '@emotion/styled'
import { useProgress } from '@react-three/drei'
import { AnimatePresence, motion } from 'motion/react'
import type { FC } from 'react'

const ProgressContainer = styled(motion.div)`
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
`

const Ring = styled('div')<{ percent: number }>`
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: conic-gradient(
    color-mix(in srgb, currentColor 66%, transparent)
      ${({ percent }) => percent * 3.6}deg,
    color-mix(in srgb, currentColor 33%, transparent) 0
  );
  mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 0);
`

export const Progress: FC = () => {
  const progress = useProgress()
  return (
    <AnimatePresence>
      {progress.active && (
        <ProgressContainer
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <Ring percent={progress.progress} />
        </ProgressContainer>
      )}
    </AnimatePresence>
  )
}
