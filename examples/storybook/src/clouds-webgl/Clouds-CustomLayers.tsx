// Vendored from three-geospatial storybook/src/clouds/Clouds-CustomLayers.tsx @ b012ad06
// (MIT, Copyright (c) 2024 Shota Matsuda), the WebGL reference storybook
// Edited: helper imports repointed; the camera is placed by PointOfView (the same pose as the WebGPU CustomLayers story); textures served locally

import { OrbitControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { EffectComposer, SMAA, ToneMapping } from '@react-three/postprocessing'
import type { StoryFn } from '@storybook/react-vite'
import { useEffect, useRef, type FC } from 'react'

import {
  AerialPerspective,
  Atmosphere,
  type AtmosphereApi
} from '@takram/three-atmosphere/r3f'
import { CloudLayer, Clouds } from '@takram/three-clouds/r3f'
import { Geodetic, PointOfView, radians } from '@takram/three-geospatial'
import { Dithering, LensFlare } from '@takram/three-geospatial-effects/r3f'

import { cloudTextureUrls } from './helpers/cloudTextureUrls'
import { Stats } from './vendor/Stats'
import { useApplyLocation } from './vendor/useApplyLocation'
import { useLocalDateControls } from './vendor/useLocalDateControls'
import { useLocationControls } from './vendor/useLocationControls'
import { useToneMappingControls } from './vendor/useToneMappingControls'

// The WebGPU CustomLayers story's pose (Clouds.stories.tsx)
const POSE = { heading: 0, pitch: -5, distance: 1000 }

const Scene: FC = () => {
  const { toneMappingMode } = useToneMappingControls({ exposure: 10 })
  const { longitude, latitude, height } = useLocationControls(
    {
      longitude: 30,
      height: 500
    },
    { collapsed: true }
  )
  const motionDate = useLocalDateControls({
    longitude,
    dayOfYear: 0,
    timeOfDay: 13
  })

  const controlsRef = useApplyLocation({ longitude, latitude, height })
  // Placed by PointOfView at the WebGPU story's pose (see Clouds-Basic)
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

  return (
    <>
      <OrbitControls ref={controlsRef} minDistance={1000} />
      <Atmosphere ref={atmosphereRef} textures='atmosphere'>
        <EffectComposer multisampling={0} enableNormalPass>
          <Clouds
            coverage={0.3}
            shadow-maxFar={1e5}
            disableDefaultLayers
            {...cloudTextureUrls}
          >
            <CloudLayer
              channel='r'
              altitude={1000}
              height={1000}
              shapeAmount={0.8}
              weatherExponent={0.6}
              shadow
            />
            <CloudLayer
              channel='g'
              altitude={2000}
              height={800}
              shapeAmount={0.8}
              shapeAlteringBias={0.5}
              densityScale={0.1}
            />
            <CloudLayer
              channel='b'
              altitude={2000}
              height={2000}
              densityScale={2e-3}
              shapeAmount={0.3}
            />
            <CloudLayer
              channel='a'
              height={300}
              densityScale={0.05}
              shapeAmount={0.2}
              shapeDetailAmount={0}
              shapeAlteringBias={0.5}
              coverageFilterWidth={1}
              densityProfile={{
                expTerm: 1,
                exponent: 1e-3,
                constantTerm: 0,
                linearTerm: 0
              }}
            />
          </Clouds>
          <AerialPerspective sky sunLight skyLight />
          <LensFlare />
          <ToneMapping mode={toneMappingMode} />
          <SMAA />
          <Dithering />
        </EffectComposer>
      </Atmosphere>
    </>
  )
}

const Story: StoryFn = () => (
  <Canvas gl={{ depth: false }} camera={{ near: 1, far: 4e5 }}>
    <Stats />
    <Scene />
  </Canvas>
)

export default Story
