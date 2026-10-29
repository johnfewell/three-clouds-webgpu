// Ported from @takram/three-clouds (MIT, Copyright (c) 2024 Shota Matsuda)
// https://github.com/takram-design-engineering/three-geospatial

// The two nodes a consumer holds: the pass's layer/depth-velocity textures, and
// the composite that blends them over the scene. Both force the pass to build on
// setup, and the composite re-builds it when the graph version moves

import { Fn, uv, vec4 } from 'three/tsl'
import {
  NodeUpdateType,
  TempNode,
  TextureNode,
  type Node,
  type NodeBuilder,
  type NodeFrame
} from 'three/webgpu'

import type { AerialPerspectiveNode } from '@takram/three-atmosphere/webgpu'

import type { CloudsPassNode } from '../CloudsPassNode'

export class CloudsTextureNode extends TextureNode {
  static get type(): string {
    return 'CloudsTextureNode'
  }

  readonly passNode: CloudsPassNode
  private readonly disabledOutput = vec4(0)

  constructor(passNode: CloudsPassNode, textureIndex: number) {
    super(passNode.layerRT.textures[textureIndex])
    this.passNode = passNode
  }

  override setup(builder: NodeBuilder): Node | null | undefined {
    if (!this.passNode.renderingEnabled) {
      return this.disabledOutput
    }
    this.passNode.build(builder)
    return super.setup(builder)
  }

  override generate(builder: NodeBuilder, output: string | null): string {
    if (!this.passNode.renderingEnabled) {
      return this.disabledOutput.build(builder, output) as string
    }
    return super.generate(builder, output)
  }
}

export class CloudsCompositeNode extends TempNode {
  static get type(): string {
    return 'CloudsCompositeNode'
  }

  private readonly passNode: CloudsPassNode
  // Any vec4-producing node, and the one place x/y/z are read. Set from the
  // union composite() takes, for the reason documented there
  private readonly dst: Node<'vec4'>
  private lastBuiltVersion = -1
  private lastBuiltInputVersion = -1
  private disposed = false
  // What to invalidate when the graph shape changes, collected at build time:
  // marking only the material was measured not to re-run setup()

  // The pipeline is the lever three uses for tone-mapping changes: its
  // needsUpdate re-assigns fragmentNode. Every pipeline that builds this node is
  // collected (the harness has two, sideB.ts:445-450)

  // Materials are a fallback for a consumer that builds outside a RenderPipeline
  private readonly builtPipelines = new Set<{ needsUpdate: boolean }>()
  private readonly builtMaterials = new Set<{ needsUpdate: boolean }>()

  constructor(
    passNode: CloudsPassNode,
    dst: Node<'vec4'> | AerialPerspectiveNode
  ) {
    super('vec4')
    this.updateBeforeType = NodeUpdateType.FRAME
    this.passNode = passNode
    this.dst = dst as Node<'vec4'>
  }

  override customCacheKey(): number {
    return this.passNode.customCacheKey()
  }

  override updateBefore(_frame: NodeFrame): boolean | undefined {
    if (this.disposed) return undefined
    const ctx = this.passNode.cloudsContext
    if (
      ctx.graphVersion !== this.lastBuiltVersion ||
      this.passNode.inputVersion !== this.lastBuiltInputVersion
    ) {
      this.needsUpdate = true
      // ADR-003: a graph-shape toggle rebuilds through graphVersion. Our own
      // version alone never reaches three, which polls only an environment
      // cache key, so every graph-shape knob left the frame unchanged

      // Marking needsUpdate bumps material.version, and RenderObjects.js then
      // rebuilds the program and re-runs setup(). Guarded by the version check,
      // or the shader would recompile every frame
      for (const pipeline of this.builtPipelines) {
        pipeline.needsUpdate = true
      }
      for (const material of this.builtMaterials) {
        material.needsUpdate = true
      }
    }
    return undefined
  }

  override setup(builder: NodeBuilder): Node | null | undefined {
    const ctx = this.passNode.cloudsContext
    this.lastBuiltVersion = ctx.graphVersion
    this.lastBuiltInputVersion = this.passNode.inputVersion
    // `builder.context`, not getContext(): both exist at runtime and return the
    // same object, but only `context` is in three's type declarations
    const buildContext = builder.context as
      { renderPipeline?: { needsUpdate: boolean } } | undefined
    if (buildContext?.renderPipeline != null) {
      this.builtPipelines.add(buildContext.renderPipeline)
    }
    if (builder.material != null) {
      this.builtMaterials.add(builder.material)
    }
    if (!this.passNode.renderingEnabled) {
      return this.dst
    }
    this.passNode.build(builder)
    // Cite: CloudsPass.ts:239–241 (output from historyRT after swap)
    const layer = this.passNode.outputTextureNode
    const dst = this.dst
    return Fn(() => {
      const clouds = layer.sample(uv())
      const oneMinusA = clouds.w.oneMinus()
      return vec4(
        dst.x.mul(oneMinusA).add(clouds.x),
        dst.y.mul(oneMinusA).add(clouds.y),
        dst.z.mul(oneMinusA).add(clouds.z),
        dst.w.mul(oneMinusA).add(clouds.w)
      )
    })()
  }

  override dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.builtPipelines.clear()
    this.builtMaterials.clear()
    super.dispose()
  }
}
