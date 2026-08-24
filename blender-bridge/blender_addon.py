"""Object Studio Blender bridge — run this inside Blender's Scripting tab
(Scripting workspace -> Open -> this file -> Run Script), or install it as a
real add-on. Starts a localhost TCP socket server that accepts newline-
delimited JSON commands and executes them on Blender's main thread.

bpy is not thread-safe, so the socket accept/read loop runs on a background
thread and only ever *queues* work; a bpy.app.timers callback drains that
queue on Blender's own main thread and writes results back to a per-command
queue the socket thread is blocked on.

Protocol: one JSON object per line in both directions.
  Request:  {"id": "<uuid>", "cmd": "<command name>", "args": {...}}
  Response: {"id": "<uuid>", "ok": true, "result": {...}}
         or {"id": "<uuid>", "ok": false, "error": "<message>"}

Commands implemented: clear_scene, create_primitive, create_text, modifier_add,
set_material_color, apply_image_texture, export_glb, import_glb, delete_object,
transform_object, export_obj, viewport_screenshot, get_scene_info. See each
handler's docstring below for its args shape.
"""

import bpy
import json
import math
import mathutils
import queue
import socket
import threading
import traceback

HOST = "127.0.0.1"
PORT = 9876

_inbox = queue.Queue()      # (request_dict, response_queue) from socket thread -> main thread
_server_socket = None
_server_thread = None
_stop_flag = threading.Event()


# ---------------------------------------------------------------------------
# Command handlers — all run on Blender's main thread (called from the timer)
# ---------------------------------------------------------------------------

def cmd_clear_scene(args):
    """Removes every mesh object in the scene (keeps camera/lights so the
    viewport stays sane for the next viewport_screenshot call)."""
    for obj in list(bpy.data.objects):
        if obj.type == "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)
    for block in list(bpy.data.meshes):
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)
    return {"cleared": True}


_PRIMITIVE_OPS = {
    "cube": lambda a: bpy.ops.mesh.primitive_cube_add(size=a.get("size", 2.0)),
    "sphere": lambda a: bpy.ops.mesh.primitive_uv_sphere_add(radius=a.get("radius", 1.0), segments=a.get("segments", 32), ring_count=a.get("ring_count", 16)),
    "cylinder": lambda a: bpy.ops.mesh.primitive_cylinder_add(radius=a.get("radius", 1.0), depth=a.get("depth", 2.0), vertices=a.get("segments", 32)),
    "cone": lambda a: bpy.ops.mesh.primitive_cone_add(radius1=a.get("radius", 1.0), depth=a.get("depth", 2.0), vertices=a.get("segments", 32)),
    "plane": lambda a: bpy.ops.mesh.primitive_plane_add(size=a.get("size", 2.0)),
    "torus": lambda a: bpy.ops.mesh.primitive_torus_add(major_radius=a.get("major_radius", 1.0), minor_radius=a.get("minor_radius", 0.25)),
}


def cmd_create_primitive(args):
    """args: {type: cube|sphere|cylinder|cone|plane|torus, location:[x,y,z],
    scale:[x,y,z], rotation_deg:[x,y,z], name: optional, ...shape params}"""
    ptype = args.get("type", "cube")
    op = _PRIMITIVE_OPS.get(ptype)
    if op is None:
        raise ValueError("unknown primitive type: " + str(ptype))
    op(args)
    obj = bpy.context.active_object
    loc = args.get("location", [0, 0, 0])
    scale = args.get("scale", [1, 1, 1])
    rot_deg = args.get("rotation_deg", [0, 0, 0])
    obj.location = loc
    obj.scale = scale
    obj.rotation_euler = [math.radians(d) for d in rot_deg]
    if args.get("name"):
        obj.name = args["name"]
    bpy.ops.object.shade_smooth() if args.get("smooth") else None
    return {"name": obj.name, "type": ptype}


def cmd_create_text(args):
    """args: {text: str, font_path: str|None (None = Blender's built-in
    default font), size, extrude, bevel_depth, bevel_resolution,
    space_character, space_word, space_line,
    align_x: LEFT|CENTER|RIGHT|JUSTIFY|FLUSH,
    align_y: TOP_BASELINE|TOP|CENTER|BOTTOM_BASELINE|BOTTOM,
    location, rotation_deg, name}. Builds a Blender TextCurve object, then
    converts it to a normal MESH object so every other handler's
    `obj.type == "MESH"` filter (clear_scene, export_glb, get_scene_info,
    apply_image_texture's UV-unwrap) keeps working on it unchanged."""
    text = args.get("text", "")
    if not text.strip():
        raise ValueError("text cannot be empty")
    bpy.ops.object.text_add(location=args.get("location", [0, 0, 0]))
    obj = bpy.context.active_object
    curve = obj.data
    curve.body = text
    font_warning = None
    font_path = args.get("font_path")
    if font_path:
        try:
            curve.font = bpy.data.fonts.load(font_path, check_existing=True)
        except Exception as e:
            font_warning = str(e)
    curve.size = args.get("size", 1.0)
    curve.extrude = args.get("extrude", 0.0)
    curve.bevel_depth = args.get("bevel_depth", 0.0)
    curve.bevel_resolution = args.get("bevel_resolution", 0)
    curve.space_character = args.get("space_character", 1.0)
    curve.space_word = args.get("space_word", 1.0)
    curve.space_line = args.get("space_line", 1.0)
    curve.align_x = args.get("align_x", "CENTER")
    curve.align_y = args.get("align_y", "CENTER")
    obj.rotation_euler = [math.radians(d) for d in args.get("rotation_deg", [0, 0, 0])]
    if args.get("name"):
        obj.name = args["name"]
    bpy.ops.object.convert(target="MESH")
    # World-space bounding-box center — used by callers (e.g. the text-sign
    # bridge endpoint) to auto-size/position a backing board behind the text.
    corners = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
    xs = [c.x for c in corners]
    ys = [c.y for c in corners]
    zs = [c.z for c in corners]
    bbox_center = [(min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2]
    return {
        "name": obj.name,
        "dimensions": list(obj.dimensions),
        "bbox_center": bbox_center,
        "font_warning": font_warning,
    }


_MODIFIER_KEYS = {
    "BEVEL": ["width", "segments"],
    "MIRROR": ["use_axis"],
    "ARRAY": ["count", "relative_offset_displace"],
    "SOLIDIFY": ["thickness"],
    "BOOLEAN": ["operation", "object"],
}


def cmd_modifier_add(args):
    """args: {object: name, type: BEVEL|MIRROR|ARRAY|SOLIDIFY|BOOLEAN,
    params: {...modifier-specific}, apply: bool}"""
    obj = bpy.data.objects.get(args["object"])
    if obj is None:
        raise ValueError("no such object: " + str(args.get("object")))
    mtype = args["type"].upper()
    mod = obj.modifiers.new(name=mtype.title(), type=mtype)
    params = args.get("params", {}) or {}
    for key, val in params.items():
        if key == "object" and mtype == "BOOLEAN":
            val = bpy.data.objects.get(val)
        try:
            setattr(mod, key, val)
        except Exception:
            pass  # unsupported/mistyped param for this modifier — skip rather than fail the whole op
    if args.get("apply"):
        prev_active = bpy.context.view_layer.objects.active
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.context.view_layer.objects.active = prev_active
    return {"object": obj.name, "modifier": mod.name}


def _ensure_material(obj):
    mat = obj.active_material
    if mat is None:
        mat = bpy.data.materials.new(name=obj.name + "_mat")
        mat.use_nodes = True
        obj.data.materials.append(mat)
    elif not mat.use_nodes:
        mat.use_nodes = True
    return mat


def cmd_set_material_color(args):
    """args: {object: name, color:[r,g,b,a], roughness: 0-1, metallic: 0-1,
    transmission: 0-1, ior: float, emission_color:[r,g,b,a],
    emission_strength: float}. The last four are optional and only set when
    present — used for material presets like glass (transmission) and neon
    glow (emission) on top of the base cube/sphere/text/etc. handlers."""
    obj = bpy.data.objects.get(args["object"])
    if obj is None:
        raise ValueError("no such object: " + str(args.get("object")))
    mat = _ensure_material(obj)
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        raise RuntimeError("material has no Principled BSDF node")
    color = args.get("color", [0.8, 0.8, 0.8, 1.0])
    bsdf.inputs["Base Color"].default_value = color
    if "roughness" in args:
        bsdf.inputs["Roughness"].default_value = args["roughness"]
    if "metallic" in args:
        bsdf.inputs["Metallic"].default_value = args["metallic"]
    if "transmission" in args:
        bsdf.inputs["Transmission Weight"].default_value = args["transmission"]
    if "ior" in args:
        bsdf.inputs["IOR"].default_value = args["ior"]
    if "emission_color" in args:
        bsdf.inputs["Emission Color"].default_value = args["emission_color"]
    if "emission_strength" in args:
        bsdf.inputs["Emission Strength"].default_value = args["emission_strength"]
    return {"object": obj.name, "material": mat.name}


def _uv_planar_z(obj):
    """Assigns UVs straight from each vertex's local X/Y position, normalized
    against the mesh's own X/Y bounding box — every face gets the same UV
    space regardless of which way it faces, so front faces (+Z normal) and
    back faces (-Z normal) end up sampling the SAME region of the texture.
    Smart UV Project can never do this for a solid extruded shape: front and
    back normals are 180 degrees apart, always exceeding any angle_limit,
    so they always land in separate, arbitrarily-packed islands — which is
    why a texture previously showed an unrelated crop on each side."""
    mesh = obj.data
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span_x = max(max_x - min_x, 1e-6)
    span_y = max(max_y - min_y, 1e-6)
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")
    uv_data = mesh.uv_layers.active.data
    for loop in mesh.loops:
        v = mesh.vertices[loop.vertex_index]
        uv_data[loop.index].uv = ((v.co.x - min_x) / span_x, (v.co.y - min_y) / span_y)


def cmd_apply_image_texture(args):
    """args: {object: name, image_path: str, projection: "smart"|"planar_z"
    (default "smart")}. "smart" runs Smart UV Project (good for arbitrary
    primitive shapes from the AI Prompt flow). "planar_z" uses _uv_planar_z
    instead — use this for flat/extruded objects like sign text and boards
    so the texture reads consistently on both the front and back rather
    than showing an unrelated crop on each side."""
    obj = bpy.data.objects.get(args["object"])
    if obj is None:
        raise ValueError("no such object: " + str(args.get("object")))
    if args.get("projection") == "planar_z":
        _uv_planar_z(obj)
    else:
        prev_active = bpy.context.view_layer.objects.active
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66))
        bpy.ops.object.mode_set(mode="OBJECT")
        bpy.context.view_layer.objects.active = prev_active

    mat = _ensure_material(obj)
    nodes = mat.node_tree.nodes
    links = mat.node_tree.links
    bsdf = nodes.get("Principled BSDF")
    img = bpy.data.images.load(args["image_path"], check_existing=True)
    tex_node = nodes.new("ShaderNodeTexImage")
    tex_node.image = img
    links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
    return {"object": obj.name, "material": mat.name, "image": img.name}


def cmd_export_glb(args):
    """args: {path: str, objects: optional [names] (default: all mesh objects)}"""
    path = args["path"]
    names = args.get("objects")
    bpy.ops.object.select_all(action="DESELECT")
    targets = [o for o in bpy.data.objects if o.type == "MESH" and (names is None or o.name in names)]
    for o in targets:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
    )
    return {"path": path, "objects": [o.name for o in targets]}


def cmd_import_glb(args):
    """args: {path: str}. Imports a .glb into the LIVE scene (via Blender's
    glTF importer) and returns the names of the newly-created mesh objects.
    Used when the user picks a previously-saved asset from the Saved
    Objects tree — without this, that asset only ever existed as a
    preview in the browser's Three.js viewer, never as a real object in
    Blender, so selecting/scaling/deleting it (which all operate on the
    live scene) would silently fail with 'no such object'."""
    path = args["path"]
    before = set(o.name for o in bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.data.objects if o.name not in before and o.type == "MESH"]
    return {"objects": [o.name for o in imported]}


def cmd_delete_object(args):
    """args: {object: name}. Removes one named mesh object (and its mesh/
    material datablocks if now unused) without touching the rest of the
    scene — used by the multi-object scene editor's per-object Delete."""
    obj = bpy.data.objects.get(args["object"])
    if obj is None:
        raise ValueError("no such object: " + str(args.get("object")))
    mesh = obj.data
    bpy.data.objects.remove(obj, do_unlink=True)
    if mesh is not None and mesh.users == 0:
        bpy.data.meshes.remove(mesh)
    for block in list(bpy.data.materials):
        if block.users == 0:
            bpy.data.materials.remove(block)
    return {"deleted": args["object"]}


def cmd_transform_object(args):
    """args: {object: name, location: optional [x,y,z] (absolute),
    rotation_deg: optional [x,y,z] (absolute Euler XYZ, degrees),
    basis: optional {x:[3],y:[3],z:[3]} (three orthonormal axis vectors,
    already in Blender space — see below), scale: optional [x,y,z]
    (absolute), scale_factor: optional float (multiplies current scale
    uniformly on all 3 axes — used by the scene editor's per-object scale
    slider so resizing preserves whatever anisotropic scale the object was
    created with, e.g. a sign board's width/height/thickness ratio)}.

    `basis` exists because the viewer's rotate gizmo operates in glTF/
    Three.js's Y-up space, not Blender's Z-up space. Converting a full 3D
    orientation between the two by hand-deriving Euler-angle composition
    in JS is exactly the kind of math that's easy to get subtly wrong
    (axis order, sign, gimbal ambiguity) with no way to visually catch it
    from the browser. Instead the caller does only the same simple,
    already-verified linear conversion used for location (swap Y/Z, negate
    the new Y) applied to each of the object's three local axis vectors,
    and sends the resulting orthonormal basis here — this function builds
    a rotation matrix from it and lets mathutils (Blender's own, trusted
    math library) do the matrix-to-Euler decomposition, guaranteeing the
    result matches obj.rotation_euler's semantics exactly. Takes priority
    over rotation_deg if both are present."""
    obj = bpy.data.objects.get(args["object"])
    if obj is None:
        raise ValueError("no such object: " + str(args.get("object")))
    if "location" in args:
        obj.location = args["location"]
    if "basis" in args:
        b = args["basis"]
        mat = mathutils.Matrix((
            (b["x"][0], b["y"][0], b["z"][0]),
            (b["x"][1], b["y"][1], b["z"][1]),
            (b["x"][2], b["y"][2], b["z"][2]),
        ))
        obj.rotation_euler = mat.to_euler()
    elif "rotation_deg" in args:
        obj.rotation_euler = [math.radians(d) for d in args["rotation_deg"]]
    if "scale" in args:
        obj.scale = args["scale"]
    if "scale_factor" in args:
        f = args["scale_factor"]
        obj.scale = [obj.scale[0] * f, obj.scale[1] * f, obj.scale[2] * f]
    return {"object": obj.name, "location": list(obj.location),
            "rotation_deg": [math.degrees(r) for r in obj.rotation_euler],
            "scale": list(obj.scale), "dimensions": list(obj.dimensions)}


def cmd_export_obj(args):
    """args: {path: str, objects: optional [names] (default: all mesh
    objects), join: bool default True}. Joins the selected objects into a
    single mesh (preserving each source object's material as a separate
    material slot on the result — bpy.ops.object.join does this natively)
    before exporting to Wavefront OBJ, so multiple separately-generated
    objects come out as one merged file. join=False exports them as
    separate objects within the same .obj instead. Always writes a
    matching .mtl next to the .obj, and copies any referenced texture
    images alongside it (path_mode='COPY') so the whole result is a
    self-contained folder the caller can zip up.

    join=True operates on TEMPORARY DUPLICATES of the target objects, not
    the live ones — joining is destructive (bpy.ops.object.join deletes the
    non-active source objects), and this command must never mutate the
    scene the user is still interactively editing (select/scale/delete).
    The duplicates are removed again after export."""
    path = args["path"]
    names = args.get("objects")
    join = args.get("join", True)
    bpy.ops.object.select_all(action="DESELECT")
    targets = [o for o in bpy.data.objects if o.type == "MESH" and (names is None or o.name in names)]
    if not targets:
        raise ValueError("no mesh objects to export")
    for o in targets:
        o.select_set(True)
    exported_names = [o.name for o in targets]
    temp_objs = []
    if join and len(targets) > 1:
        bpy.context.view_layer.objects.active = targets[0]
        bpy.ops.object.duplicate()  # duplicates inherit the source selection + become newly selected/active
        temp_objs = list(bpy.context.selected_objects)
        bpy.ops.object.join()
        exported_names = [bpy.context.view_layer.objects.active.name]
        temp_objs = [bpy.context.view_layer.objects.active]
    try:
        bpy.ops.wm.obj_export(
            filepath=path,
            export_selected_objects=True,
            export_materials=True,
            path_mode="COPY",
            forward_axis="NEGATIVE_Z",
            up_axis="Y",
        )
    finally:
        for o in temp_objs:
            bpy.data.objects.remove(o, do_unlink=True)
    return {"path": path, "objects": exported_names, "joined": join and len(targets) > 1}


def cmd_viewport_screenshot(args):
    """args: {path: str}. Renders the current 3D viewport to a PNG so the
    driving agent can look at intermediate results and adjust course."""
    path = args["path"]
    for area in bpy.context.screen.areas:
        if area.type == "VIEW_3D":
            with bpy.context.temp_override(area=area):
                bpy.ops.view3d.view_all()
                bpy.context.scene.render.filepath = path
                bpy.ops.render.opengl(write_still=True)
            return {"path": path}
    raise RuntimeError("no 3D viewport area found — open a 3D Viewport in Blender")


def cmd_get_scene_info(args):
    objs = []
    for o in bpy.data.objects:
        if o.type == "MESH":
            objs.append({
                "name": o.name,
                "location": list(o.location),
                "dimensions": list(o.dimensions),
                "modifiers": [m.name for m in o.modifiers],
            })
    return {"objects": objs}


_HANDLERS = {
    "clear_scene": cmd_clear_scene,
    "create_primitive": cmd_create_primitive,
    "create_text": cmd_create_text,
    "modifier_add": cmd_modifier_add,
    "set_material_color": cmd_set_material_color,
    "apply_image_texture": cmd_apply_image_texture,
    "export_glb": cmd_export_glb,
    "import_glb": cmd_import_glb,
    "delete_object": cmd_delete_object,
    "transform_object": cmd_transform_object,
    "export_obj": cmd_export_obj,
    "viewport_screenshot": cmd_viewport_screenshot,
    "get_scene_info": cmd_get_scene_info,
}


# ---------------------------------------------------------------------------
# Socket server (background thread) + main-thread drain timer
# ---------------------------------------------------------------------------

def _handle_client(conn):
    buf = b""
    try:
        with conn:
            while not _stop_flag.is_set():
                chunk = conn.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    req = json.loads(line.decode("utf-8"))
                    resp_q = queue.Queue()
                    _inbox.put((req, resp_q))
                    resp = resp_q.get()  # blocks until the main-thread timer executes it
                    conn.sendall((json.dumps(resp) + "\n").encode("utf-8"))
    except (ConnectionResetError, BrokenPipeError):
        pass


def _accept_loop():
    global _server_socket
    _server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    _server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    _server_socket.bind((HOST, PORT))
    _server_socket.listen(5)
    _server_socket.settimeout(1.0)
    print(f"[object-studio] Blender bridge listening on {HOST}:{PORT}")
    while not _stop_flag.is_set():
        try:
            conn, _addr = _server_socket.accept()
        except socket.timeout:
            continue
        except OSError:
            break
        threading.Thread(target=_handle_client, args=(conn,), daemon=True).start()


def _drain_timer():
    """Runs on Blender's main thread. Executes at most one queued command per
    tick so a slow/broken command can't hang the UI indefinitely."""
    try:
        req, resp_q = _inbox.get_nowait()
    except queue.Empty:
        return 0.05
    handler = _HANDLERS.get(req.get("cmd"))
    try:
        if handler is None:
            raise ValueError("unknown command: " + str(req.get("cmd")))
        result = handler(req.get("args", {}) or {})
        resp_q.put({"id": req.get("id"), "ok": True, "result": result})
    except Exception as e:
        traceback.print_exc()
        resp_q.put({"id": req.get("id"), "ok": False, "error": str(e)})
    return 0.05


def start():
    global _server_thread
    if _server_thread and _server_thread.is_alive():
        print("[object-studio] bridge already running")
        return
    _stop_flag.clear()
    _server_thread = threading.Thread(target=_accept_loop, daemon=True)
    _server_thread.start()
    if not bpy.app.timers.is_registered(_drain_timer):
        bpy.app.timers.register(_drain_timer, persistent=True)


def stop():
    _stop_flag.set()
    if _server_socket:
        try:
            _server_socket.close()
        except OSError:
            pass
    if bpy.app.timers.is_registered(_drain_timer):
        bpy.app.timers.unregister(_drain_timer)


start()
