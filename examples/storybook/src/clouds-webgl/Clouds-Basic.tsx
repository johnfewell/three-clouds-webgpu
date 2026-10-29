// Vendored from three-geospatial storybook/src/clouds/Clouds-Basic.tsx @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda), the WebGL reference storybook
// Edited: helper imports repointed; the camera is placed by PointOfView (the same pose as the WebGPU Basic story) so the two are one sidebar click apart with identical framing; textures served locally; the canvas is a named export for the Fallback story

import { Box, OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, SMAA, ToneMapping } from '@react-three/postprocessing'
import type { StoryFn } from '@storybook/react-vite'
import { Fragment, useEffect, useRef, useState, type FC } from 'react'

import {
  AerialPerspective,
  Atmosphere,
  type AtmosphereApi
} from '@takram/three-atmosphere/r3f'
import type { CloudsEffect } from '@takram/three-clouds'
import { Clouds } from '@takram/three-clouds/r3f'
import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'
import { EastNorthUpFrame } from '@takram/three-geospatial/r3f'

import { cloudTextureUrls } from './helpers/cloudTextureUrls'
import { Stats } from './vendor/Stats'
import { useApplyLocation } from './vendor/useApplyLocation'
import { useCloudsControls } from './vendor/useCloudsControls'
import { useControls } from './vendor/useControls'
import { useLocalDateControls } from './vendor/useLocalDateControls'
import { useLocationControls } from './vendor/useLocationControls'
import { useToneMappingControls } from './vendor/useToneMappingControls'

// The WebGPU Basic story's pose (Clouds.stories.tsx), so the two frame alike
const POSE = { heading: 0, pitch: -5, distance: 1000 }

const Scene: FC = () => {
  const { toneMappingMode } = useToneMappingControls({ exposure: 10 })
  const { longitude, latitude, height } = useLocationControls(
    {
      longitude: 30,
      height: 300
    },
    { collapsed: true }
  )
  const motionDate = useLocalDateControls({ longitude, dayOfYear: 0 })
  const { correctAltitude } = useControls(
    'atmosphere',
    { correctAltitude: true },
    { collapsed: true }
  )

  const controlsRef = useApplyLocation({ longitude, latitude, height })
  // Placed by PointOfView at the WebGPU story's pose (upstream leaves the
  // Canvas default offset), so the A/B pair frames identically. Declared
  // after useApplyLocation, so its effect runs after that hook's
  const camera = useThree(({ camera }) => camera)
  useEffect(() => {
    const target = new Geodetic(
      radians(longitude),
      radians(latitude),
      height
    ).toECEF()
    new PointOfView(
      POSE.distance,
      radians(POSE.heading),
      radians(POSE.pitch)
    ).decompose(target, camera.position, camera.quaternion, camera.up)
    controlsRef.current?.target.copy(target)
  }, [camera, controlsRef, longitude, latitude, height])
  const atmosphereRef = useRef<AtmosphereApi>(null)
  useFrame(() => {
    atmosphereRef.current?.updateByDate(new Date(motionDate.get()))
  })

  const [clouds, setClouds] = useState<CloudsEffect | null>(null)
  const [{ enabled, toneMapping }, cloudsProps] = useCloudsControls(clouds)

  const { showBox: debugShowBox } = useControls(
    'debug',
    { showBox: false },
    { collapsed: true }
  )

  return (
    <>
      <OrbitControls ref={controlsRef} minDistance={1000} />
      {debugShowBox && (
        <EastNorthUpFrame
          longitude={radians(longitude)}
          latitude={radians(latitude)}
        >
          <Box
            args={[2e3, 2e3, 2e3]}
            position={[1e3, -2e3, 1e3]}
            rotation={[Math.PI / 4, Math.PI / 4, 0]}
          >
            <meshBasicMaterial color='white' />
          </Box>
        </EastNorthUpFrame>
      )}
      <Atmosphere
        ref={atmosphereRef}
        correctAltitude={correctAltitude}
        textures='atmosphere'
      >
        <EffectComposer multisampling={0} enableNormalPass>
          <Fragment key={JSON.stringify([enabled, toneMapping])}>
            {enabled && (
              <Clouds
                ref={setClouds}
                shadow-maxFar={1e5}
                {...cloudTextureUrls}
                {...cloudsProps}
              />
            )}
            <AerialPerspective sky sunLight skyLight />
            {toneMapping && (
              <>
                <LensFlare />
                <ToneMapping mode={toneMappingMode} />
                <SMAA />
                <Dithering />
              </>
            )}
          </Fragment>
        </EffectComposer>
      </Atmosphere>
    </>
  )
}

// Named so the Fallback story can mount the reference beside its own branch
export const Basic: FC = () => (
  <Canvas gl={{ depth: false }} camera={{ near: 1, far: 4e5 }}>
    <Stats />
    <Scene />
  </Canvas>
)

const Story: StoryFn = () => <Basic />

export default Story
