import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { PIECE_HEIGHT, PIECE_RADIUS, SURFACE_Y } from './config.ts';

/**
 * Rapier is used only for spectacle: a captured piece becomes a rigid body that
 * tumbles off the board, and the whole board can be knocked for a "table
 * bump". Game outcomes never depend on the simulation, which keeps the
 * authoritative rules deterministic while still giving the scene weight.
 */

const GRAVITY = { x: 0, y: -22, z: 0 };
const FIXED_STEP = 1 / 120;
const MAX_SUBSTEPS = 4;

export interface DebrisHandle {
  body: RAPIER.RigidBody;
  mesh: THREE.Object3D;
  bornAt: number;
}

export class PhysicsWorld {
  private world: RAPIER.World;
  private accumulator = 0;
  private debris: DebrisHandle[] = [];
  private readonly staticBodies: RAPIER.RigidBody[] = [];
  private disposed = false;

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(): Promise<PhysicsWorld> {
    await RAPIER.init();
    const world = new RAPIER.World(GRAVITY);
    world.integrationParameters.dt = FIXED_STEP;
    return new PhysicsWorld(world);
  }

  /** A static floor far below the board so debris eventually comes to rest. */
  addFloor(y: number): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, y, 0),
    );
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(60, 0.5, 60), body);
    this.staticBodies.push(body);
  }

  /** The board slab, so debris actually bounces off the playing surface. */
  addBoardSurface(halfWidth: number, halfDepth: number): void {
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, SURFACE_Y - 0.05, 0),
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(halfWidth, 0.05, halfDepth).setFriction(0.9),
      body,
    );
    this.staticBodies.push(body);
  }

  /**
   * Turn a captured piece mesh into a tumbling body. The mesh stays in the
   * scene and is driven by the simulation until it is retired.
   */
  launchDebris(
    mesh: THREE.Object3D,
    impulse: THREE.Vector3,
    spin: THREE.Vector3,
  ): DebrisHandle {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(mesh.position.x, Math.max(mesh.position.y, SURFACE_Y + 0.3), mesh.position.z)
      .setLinearDamping(0.12)
      .setAngularDamping(0.25)
      .setCcdEnabled(true);

    const body = this.world.createRigidBody(desc);
    const collider = RAPIER.ColliderDesc.cylinder(PIECE_HEIGHT / 2, PIECE_RADIUS)
      .setDensity(1.4)
      .setRestitution(0.35)
      .setFriction(0.6);
    this.world.createCollider(collider, body);

    body.applyImpulse({ x: impulse.x, y: impulse.y, z: impulse.z }, true);
    body.applyTorqueImpulse({ x: spin.x, y: spin.y, z: spin.z }, true);

    const handle: DebrisHandle = { body, mesh, bornAt: performance.now() };
    this.debris.push(handle);
    return handle;
  }

  /** Advance the simulation and copy transforms onto the debris meshes. */
  step(deltaSeconds: number): void {
    this.accumulator += Math.min(deltaSeconds, 0.1);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_SUBSTEPS) {
      this.world.step();
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;

    const now = performance.now();
    for (const item of this.debris) {
      const translation = item.body.translation();
      const rotation = item.body.rotation();
      item.mesh.position.set(translation.x, translation.y, translation.z);
      item.mesh.quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      // Retire bodies that have fallen out of sight.
      if (translation.y < -18 || now - item.bornAt > 12_000) {
        item.mesh.visible = false;
      }
    }
  }

  removeDebris(): void {
    for (const item of this.debris) {
      this.world.removeRigidBody(item.body);
      item.mesh.visible = false;
    }
    this.debris.length = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeDebris();
    for (const body of this.staticBodies) this.world.removeRigidBody(body);
    this.staticBodies.length = 0;
    this.world.free();
  }
}
