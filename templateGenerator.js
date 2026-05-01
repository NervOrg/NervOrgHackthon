import fs from 'node:fs/promises';
import path from 'node:path';

import { callMcpTool } from './mcpClient.js';
import { buildComponentManifest } from './openaiAgent.js';
import { inspectGlb } from './glbInspector.js';

const ASSETS_DIR = path.resolve('assets');

export function hasTemplate(prompt) {
  return templateKind(prompt) !== null;
}

export async function generateFromTemplate({ id, prompt, onProgress = () => {} }) {
  const kind = templateKind(prompt);
  if (kind === 'basketball') return generateBasketball({ id, onProgress });
  if (kind === 'traffic-cone') return generateTrafficCone({ id, onProgress });
  return null;
}

function templateKind(prompt = '') {
  const text = String(prompt).toLowerCase();
  if (/\bbasket\s*ball\b|\bbasketball\b/.test(text)) return 'basketball';
  if (/\btraffic\s+cone\b|\bsafety\s+cone\b|\broad\s+cone\b|\bcone\b/.test(text)) return 'traffic-cone';
  return null;
}

async function generateBasketball({ id, onProgress }) {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  const glbPath = path.join(ASSETS_DIR, `${id}.glb`);
  await fs.rm(glbPath, { force: true });

  onProgress('Using deterministic basketball template');
  await callMcpTool('execute_blender_code', {
    user_prompt: 'Create deterministic basketball template',
    code: basketballBlenderScript(toBlenderPath(glbPath)),
  });

  const report = await inspectGlb(glbPath);
  const components = buildComponentManifest(report);
  onProgress(`Template created ${report.counts.meshPrimitives} mesh primitive(s)`);
  return {
    glb_url: `/assets/${id}.glb`,
    animation_count: report.counts.animations || 0,
    components,
  };
}

async function generateTrafficCone({ id, onProgress }) {
  await fs.mkdir(ASSETS_DIR, { recursive: true });
  const glbPath = path.join(ASSETS_DIR, `${id}.glb`);
  await fs.rm(glbPath, { force: true });

  onProgress('Using deterministic traffic cone template');
  await callMcpTool('execute_blender_code', {
    user_prompt: 'Create deterministic traffic cone template',
    code: trafficConeBlenderScript(toBlenderPath(glbPath)),
  });

  const report = await inspectGlb(glbPath);
  const components = buildComponentManifest(report);
  onProgress(`Template created ${report.counts.meshPrimitives} mesh primitive(s)`);
  return {
    glb_url: `/assets/${id}.glb`,
    animation_count: report.counts.animations || 0,
    components,
  };
}

function trafficConeBlenderScript(glbPath) {
  return String.raw`
import bpy, math

OUT = ${JSON.stringify(glbPath)}
SEGMENTS = 48
BASE_HEIGHT = 0.12
CONE_BOTTOM_Z = BASE_HEIGHT
CONE_HEIGHT = 1.15
CONE_TOP_Z = CONE_BOTTOM_Z + CONE_HEIGHT
BOTTOM_RADIUS = 0.43
TOP_RADIUS = 0.075

def clear_generated():
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith("TrafficCone"):
            bpy.data.objects.remove(obj, do_unlink=True)

def make_mat(name, color, roughness=0.72):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
    return mat

def radius_at(z):
    t = max(0.0, min(1.0, (z - CONE_BOTTOM_Z) / CONE_HEIGHT))
    return BOTTOM_RADIUS + (TOP_RADIUS - BOTTOM_RADIUS) * t

def make_band_mesh(name, z_min, z_max, outward=0.012):
    verts = []
    faces = []
    for z in (z_min, z_max):
        r = radius_at(z) + outward
        for i in range(SEGMENTS):
            a = math.tau * i / SEGMENTS
            verts.append((math.cos(a) * r, math.sin(a) * r, z))
    for i in range(SEGMENTS):
        j = (i + 1) % SEGMENTS
        faces.append((i, j, SEGMENTS + j, SEGMENTS + i))
    mesh = bpy.data.meshes.new(name + "_Mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(white_mat)
    return obj

clear_generated()
orange_mat = make_mat("TrafficCone_Orange_Body", (0.95, 0.28, 0.035, 1.0))
white_mat = make_mat("TrafficCone_White_Reflective_Bands", (0.95, 0.93, 0.86, 1.0), 0.45)
base_mat = make_mat("TrafficCone_Black_Rubber_Base", (0.018, 0.017, 0.015, 1.0), 0.88)

bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
root = bpy.context.object
root.name = "TrafficCone_Root"

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, BASE_HEIGHT / 2))
base = bpy.context.object
base.name = "TrafficCone_Black_Rubber_Base"
base.data.name = "TrafficCone_Black_Rubber_Base_Mesh"
base.dimensions = (1.05, 1.05, BASE_HEIGHT)
bpy.context.view_layer.objects.active = base
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
base.data.materials.append(base_mat)
base.parent = root

bpy.ops.mesh.primitive_cone_add(
    vertices=SEGMENTS,
    radius1=BOTTOM_RADIUS,
    radius2=TOP_RADIUS,
    depth=CONE_HEIGHT,
    end_fill_type="TRIFAN",
    location=(0, 0, CONE_BOTTOM_Z + CONE_HEIGHT / 2),
)
body = bpy.context.object
body.name = "TrafficCone_Orange_Body"
body.data.name = "TrafficCone_Orange_Body_Mesh"
body.data.materials.append(orange_mat)
body.parent = root

bands = [
    make_band_mesh("TrafficCone_White_Reflective_Bands_Lower", 0.38, 0.49),
    make_band_mesh("TrafficCone_White_Reflective_Bands_Upper", 0.78, 0.88),
]
bpy.ops.object.select_all(action="DESELECT")
for obj in bands:
    obj.select_set(True)
bpy.context.view_layer.objects.active = bands[0]
bpy.ops.object.join()
band_mesh = bpy.context.object
band_mesh.name = "TrafficCone_White_Reflective_Bands"
band_mesh.data.name = "TrafficCone_White_Reflective_Bands_Mesh"
band_mesh.parent = root

bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = 72
root.rotation_euler = (0, 0, -0.035)
root.keyframe_insert(data_path="rotation_euler", frame=1)
root.rotation_euler = (0, 0, 0.035)
root.keyframe_insert(data_path="rotation_euler", frame=36)
root.rotation_euler = (0, 0, -0.035)
root.keyframe_insert(data_path="rotation_euler", frame=72)
if root.animation_data and root.animation_data.action:
    root.animation_data.action.name = "TrafficCone_Subtle_Wobble"
    for fc in getattr(root.animation_data.action, "fcurves", []):
        fc.modifiers.new(type="CYCLES")

bpy.ops.object.select_all(action="DESELECT")
for obj in [root, base, body, band_mesh]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=True,
    export_materials="EXPORT",
    export_animations=True,
    export_bake_animation=True,
)
`;
}

function basketballBlenderScript(glbPath) {
  return String.raw`
import bpy, math
from mathutils import Vector

OUT = ${JSON.stringify(glbPath)}
RADIUS = 0.8
SEAM_RADIUS = RADIUS * 1.006
SEAM_THICKNESS = 0.018
CENTER_Z = SEAM_RADIUS + SEAM_THICKNESS

def clear_generated():
    for obj in list(bpy.context.scene.objects):
        if obj.name.startswith("Basketball"):
            bpy.data.objects.remove(obj, do_unlink=True)

def make_mat(name, color, roughness=0.75):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
    return mat

def apply_mesh_transform(obj):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    obj.select_set(False)

def add_torus(name, rotation):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=SEAM_RADIUS,
        minor_radius=SEAM_THICKNESS,
        major_segments=96,
        minor_segments=8,
        location=(0, 0, CENTER_Z),
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name + "_Mesh"
    obj.data.materials.append(seam_mat)
    apply_mesh_transform(obj)
    return obj

def make_curve_seam(name, points):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = 3
    curve.bevel_depth = SEAM_THICKNESS
    curve.bevel_resolution = 3
    curve.use_path = False
    poly = curve.splines.new("POLY")
    poly.points.add(len(points) - 1)
    for p, co in zip(poly.points, points):
        p.co = (co[0], co[1], co[2], 1.0)
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(seam_mat)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.object
    obj.name = name
    obj.data.name = name + "_Mesh"
    obj.select_set(False)
    return obj

def side_seam_points(x_sign):
    points = []
    # Basketball side seams are offset curves on the ball surface, not random panels.
    for i in range(97):
        t = (i / 96.0) * math.tau
        y = math.cos(t) * SEAM_RADIUS
        z_offset = math.sin(t) * SEAM_RADIUS * 0.86
        x = x_sign * (0.30 + 0.18 * math.cos(t)) * RADIUS
        v = Vector((x, y, z_offset))
        if v.length > 0:
            v.normalize()
        v *= SEAM_RADIUS
        points.append((v.x, v.y, CENTER_Z + v.z))
    return points

clear_generated()
orange_mat = make_mat("Basketball_Orange_Leather", (0.95, 0.33, 0.055, 1.0))
seam_mat = make_mat("Basketball_Black_Seams", (0.012, 0.010, 0.008, 1.0), 0.9)

bpy.ops.object.empty_add(type="PLAIN_AXES", location=(0, 0, 0))
root = bpy.context.object
root.name = "Basketball_Root"

bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=RADIUS, location=(0, 0, CENTER_Z))
body = bpy.context.object
body.name = "Basketball_Ball_Surface"
body.data.name = "Basketball_Ball_Surface_Mesh"
body.data.materials.append(orange_mat)
body.parent = root

seams = [
    add_torus("Basketball_Black_Seams_Equator", (0, 0, 0)),
    add_torus("Basketball_Detail_Seam_Vertical_A", (math.pi / 2, 0, 0)),
    add_torus("Basketball_Detail_Seam_Vertical_B", (0, math.pi / 2, 0)),
    make_curve_seam("Basketball_Detail_Seam_Side_L", side_seam_points(-1)),
    make_curve_seam("Basketball_Detail_Seam_Side_R", side_seam_points(1)),
]

bpy.ops.object.select_all(action="DESELECT")
for obj in seams:
    obj.select_set(True)
bpy.context.view_layer.objects.active = seams[0]
bpy.ops.object.join()
seams_mesh = bpy.context.object
seams_mesh.name = "Basketball_Black_Seams"
seams_mesh.data.name = "Basketball_Black_Seams_Mesh"
seams_mesh.parent = root

bpy.context.scene.frame_start = 1
bpy.context.scene.frame_end = 80
root.rotation_euler = (0, 0, 0)
root.keyframe_insert(data_path="rotation_euler", frame=1)
root.rotation_euler = (0, 0, math.tau)
root.keyframe_insert(data_path="rotation_euler", frame=80)
if root.animation_data and root.animation_data.action:
    root.animation_data.action.name = "Basketball_Roll_Idle"
    for fc in getattr(root.animation_data.action, "fcurves", []):
        fc.modifiers.new(type="CYCLES")
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"

bpy.ops.object.select_all(action="DESELECT")
for obj in [root, body, seams_mesh]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = root
bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    use_selection=True,
    export_materials="EXPORT",
    export_animations=True,
    export_bake_animation=True,
)
`;
}

function toBlenderPath(p) {
  const normalized = path.resolve(p).replaceAll('\\', '/');
  const match = normalized.match(/^\/mnt\/([a-zA-Z])\/(.+)$/);
  if (!match) return normalized;
  return `${match[1].toUpperCase()}:/${match[2]}`;
}
