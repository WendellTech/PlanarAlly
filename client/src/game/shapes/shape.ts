import clamp from "lodash/clamp";

import type { ApiCoreShape, ApiShape } from "../../apiTypes";
import { g2l, g2lx, g2ly, g2lz, getUnitDistance } from "../../core/conversions";
import { addP, cloneP, equalsP, subtractP, toArrayP, toGP, Vector } from "../../core/geometry";
import type { GlobalPoint } from "../../core/geometry";
import { rotateAroundPoint } from "../../core/math";
import { mostReadable } from "../../core/utils";
import { generateLocalId, getGlobalId } from "../id";
import type { GlobalId, LocalId } from "../id";
import type { ILayer } from "../interfaces/layer";
import type { IShape } from "../interfaces/shape";
import { LayerName } from "../models/floor";
import type { Floor, FloorId } from "../models/floor";
import type { ServerShapeOptions, ShapeOptions } from "../models/shapes";
import { accessSystem } from "../systems/access";
import { ownerToClient, ownerToServer } from "../systems/access/helpers";
import { annotationSystem } from "../systems/annotations";
import { annotationState } from "../systems/annotations/state";
import { auraSystem } from "../systems/auras";
import { aurasFromServer, aurasToServer } from "../systems/auras/conversion";
import { characterSystem } from "../systems/characters";
import type { CharacterId } from "../systems/characters/models";
import { floorSystem } from "../systems/floors";
import { floorState } from "../systems/floors/state";
import { groupSystem } from "../systems/groups";
import { labelSystem } from "../systems/labels";
import { doorSystem } from "../systems/logic/door";
import { teleportZoneSystem } from "../systems/logic/tp";
import { propertiesSystem } from "../systems/properties";
import { getProperties } from "../systems/properties/state";
import type { ShapeProperties } from "../systems/properties/state";
import { playerSettingsState } from "../systems/settings/players/state";
import { trackerSystem } from "../systems/trackers";
import { trackersFromServer, trackersToServer } from "../systems/trackers/conversion";
import { TriangulationTarget, visionState } from "../vision/state";
import { computeVisibility } from "../vision/te";

import type { SHAPE_TYPE } from "./types";
import { BoundingRect } from "./variants/simple/boundingRect";

export abstract class Shape implements IShape {
    // Used to create class instance from server shape data
    abstract readonly type: SHAPE_TYPE;
    readonly id: LocalId;

    character: CharacterId | undefined;

    // The layer the shape is currently on
    floorId: FloorId | undefined;
    layerName: LayerName | undefined;

    // A reference point regarding that specific shape's structure
    protected _refPoint: GlobalPoint;
    protected _angle = 0;
    protected _center!: GlobalPoint;

    protected _points: [number, number][] = [];
    protected _shadowPoints: [number, number][] | undefined = undefined;
    get points(): [number, number][] {
        return this._points;
    }
    get shadowPoints(): [number, number][] {
        return this._shadowPoints ?? this._points;
    }

    abstract contains(point: GlobalPoint, nearbyThreshold?: number): boolean;

    abstract snapToGrid(): void;
    abstract resizeToGrid(resizePoint: number, retainAspectRatio: boolean): void;
    abstract resize(resizePoint: number, point: GlobalPoint, retainAspectRatio: boolean): number;

    strokeWidth: number;

    assetId?: number;

    // Draw mode to use
    globalCompositeOperation: GlobalCompositeOperation = "source-over";

    showHighlight = false;

    // When set to true this shape should not use g2lz converting logic for its sizing
    // This is used for things like the ruler, which should always have the same size irregardles of zoom state
    ignoreZoomSize = false;

    // Explicitly prevent any sync to the server
    preventSync = false;

    // Decides whether its points can be snapped to
    isSnappable = true;

    // Additional options for specialized uses
    options: Partial<ShapeOptions> = {};

    private floorIteration = -1;
    private visionIteration = -1;
    private _visionPolygon: [number, number][] | undefined = undefined;
    private _visionPath: Path2D | undefined = undefined;
    _visionBbox: BoundingRect | undefined = undefined;

    constructor(
        refPoint: GlobalPoint,
        options?: {
            id?: LocalId;
            uuid?: GlobalId;
            assetId?: number;
            strokeWidth?: number;
            isSnappable?: boolean;
        },
        properties?: Partial<ShapeProperties>,
    ) {
        this._refPoint = refPoint;
        this.id = options?.id ?? generateLocalId(this, options?.uuid);
        this.assetId = options?.assetId;
        this.strokeWidth = options?.strokeWidth ?? 5;
        this.isSnappable = options?.isSnappable ?? true;

        propertiesSystem.inform(this.id, properties);
    }

    abstract __center(): GlobalPoint;
    get center(): GlobalPoint {
        return this._center;
    }
    set center(centerPoint: GlobalPoint) {
        this._center = centerPoint;
        this._visionPolygon = undefined;
    }

    // Informs whether `points` forms a close loop
    abstract get isClosed(): boolean;

    /**
     * Returns true if this shape should trigger a vision recalculation when it moves or otherwise mutates.
     * This is the case when it is a token, has an aura that is a vision source or if it blocks vision.
     */
    get triggersVisionRecalc(): boolean {
        const props = getProperties(this.id)!;
        return props.isToken || props.blocksMovement || auraSystem.getAll(this.id, true).some((a) => a.visionSource);
    }

    resetVisionIteration(): void {
        this.visionIteration = -1;
    }

    // todo: Currently Aura changes do not trigger this, investigate if we want to do the extra effort
    private recalcVisionBbox(): void {
        if (this._visionPolygon === undefined || this._visionPolygon.length === 0) {
            this._visionBbox = undefined;
            return;
        }

        let x = this._visionPolygon[0]![0];
        let y = this._visionPolygon[0]![1];
        let leftX = x;
        let rightX = x;
        let topY = y;
        let botY = y;
        for (const point of this._visionPolygon) {
            x = point[0];
            y = point[1];
            if (leftX > x) leftX = x;
            else if (rightX < x) rightX = x;
            if (topY > y) topY = y;
            else if (botY < y) botY = y;
        }
        this._visionBbox = new BoundingRect(toGP(leftX, topY), rightX - leftX, botY - topY).intersect(
            this.getAuraAABB({ onlyVisionSources: true }),
        );
    }

    get visionPolygon(): Path2D {
        if (this.floorId === undefined) return new Path2D();

        const floorIteration = floorState.readonly.iteration;
        const visionIteration = visionState.getVisionIteration(this.floorId);
        const visionAltered = visionIteration !== this.visionIteration;
        if (this._visionPolygon === undefined || visionAltered) {
            this._visionPolygon = computeVisibility(this.center, TriangulationTarget.VISION, this.floorId);
            this.visionIteration = visionIteration;
            this.recalcVisionBbox();
        }
        if (this._visionPath === undefined || floorIteration != this.floorIteration || visionAltered) {
            const path = new Path2D();
            path.moveTo(g2lx(this._visionPolygon[0]![0]), g2ly(this._visionPolygon[0]![1]));
            for (const point of this._visionPolygon) path.lineTo(g2lx(point[0]), g2ly(point[1]));
            path.closePath();
            this._visionPath = path;
            this.floorIteration = floorIteration;
        }
        return this._visionPath;
    }

    onLayerAdd(): void {}

    // POSITION

    get floor(): Floor | undefined {
        if (this.floorId === undefined) return undefined;
        return floorSystem.getFloor({ id: this.floorId });
    }

    get layer(): ILayer | undefined {
        const floor = this.floor;
        if (floor === undefined || this.layerName === undefined) return undefined;
        return floorSystem.getLayer(floor, this.layerName);
    }

    get refPoint(): GlobalPoint {
        return cloneP(this._refPoint);
    }
    set refPoint(point: GlobalPoint) {
        this._refPoint = point;
        this._center = this.__center();
        this.resetVisionIteration();
        this.invalidatePoints();
        if (getProperties(this.id)?.isToken === true) {
            const floor = this.floor;
            if (floor !== undefined) floorSystem.getLayer(floor, LayerName.Draw)?.invalidate(true);
        }
    }

    get angle(): number {
        return this._angle;
    }

    set angle(angle: number) {
        this._angle = angle;
        this.invalidatePoints();
    }

    setLayer(floor: FloorId, layer: LayerName): void {
        this.floorId = floor;
        this.layerName = layer;
    }

    getPositionRepresentation(): { angle: number; points: [number, number][] } {
        return { angle: this.angle, points: [toArrayP(this.refPoint)] };
    }

    setPositionRepresentation(position: { angle: number; points: [number, number][] }): void {
        if (position.points.length === 0) return;

        this._refPoint = toGP(position.points[0]!);
        this._center = this.__center();
        this.angle = position.angle;
        this.resetVisionIteration();
        this.updateShapeVision(false, false);
        if (getProperties(this.id)?.isToken === true) {
            const floor = this.floor;
            if (floor !== undefined) floorSystem.getLayer(floor, LayerName.Draw)?.invalidate(true);
        }
    }

    invalidate(skipLightUpdate: boolean): void {
        if (this.layerName !== undefined) this.layer!.invalidate(skipLightUpdate);
    }

    // @mustOverride
    invalidatePoints(): void {
        this.layer?.updateSectors(this.id, this.getAuraAABB());
        if (this.isSnappable) this.updateLayerPoints();
    }

    updateLayerPoints(): void {
        for (const point of this.layer?.points ?? []) {
            if (point[1].has(this.id)) {
                if (point[1].size === 1) this.layer?.points.delete(point[0]);
                else point[1].delete(this.id);
            }
        }
        for (const point of this.points) {
            const strp = JSON.stringify(point);
            const layer = this.layer;
            if (layer !== undefined) {
                if (layer.points.has(strp)) layer.points.get(strp)!.add(this.id);
                else layer.points.set(strp, new Set([this.id]));
            }
        }
    }

    rotateAround(point: GlobalPoint, angle: number): void {
        const center = this.center;
        if (!equalsP(point, center)) this.center = rotateAroundPoint(center, point, angle);
        this.angle += angle;
    }

    rotateAroundAbsolute(point: GlobalPoint, angle: number): void {
        this.rotateAround(point, angle - this.angle);
    }

    getPointIndex(p: GlobalPoint, delta = 0): number {
        for (const [idx, point] of this.points.entries()) {
            if (Math.abs(p.x - point[0]) <= delta && Math.abs(p.y - point[1]) <= delta) return idx;
        }
        return -1;
    }

    getPointOrientation(i: number): Vector {
        const points = this.points; // this is an expensive function
        const prev = toGP(points[(points.length + i - 1) % points.length]!);
        const point = toGP(points[i]!);
        const next = toGP(points[(i + 1) % points.length]!);
        const vec = subtractP(next, prev);
        const mid = addP(prev, vec.multiply(0.5));
        return subtractP(point, mid).normalize();
    }

    // DRAWING

    draw(ctx: CanvasRenderingContext2D, customScale?: { center: GlobalPoint; width: number; height: number }): void {
        if (this.globalCompositeOperation !== undefined) ctx.globalCompositeOperation = this.globalCompositeOperation;
        else ctx.globalCompositeOperation = "source-over";

        const center = g2l(customScale?.center ?? this.center);
        const pixelRatio = playerSettingsState.devicePixelRatio.value;

        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, center.x * pixelRatio, center.y * pixelRatio);
        ctx.rotate(this.angle);
    }

    drawPost(ctx: CanvasRenderingContext2D): void {
        const pixelRatio = playerSettingsState.devicePixelRatio.value;
        ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
        const props = getProperties(this.id);
        if (props === undefined) return console.error("Missing props");

        let bbox: BoundingRect | undefined;
        if (props.showBadge) {
            bbox = this.getBoundingBox();
            const location = g2l(bbox.botRight);
            const crossLength = g2lz(Math.min(bbox.w, bbox.h));
            const r = crossLength * 0.2;
            ctx.strokeStyle = "black";
            ctx.fillStyle = props.strokeColour[0]!;
            ctx.lineWidth = g2lz(2);
            ctx.beginPath();
            ctx.arc(location.x - r, location.y - r, r, 0, 2 * Math.PI);
            ctx.stroke();
            ctx.fill();
            ctx.fillStyle = mostReadable(props.strokeColour[0]!);

            const badgeChars = groupSystem.getBadgeCharacters(this.id);
            const scalingFactor = 2.3 - 0.5 * badgeChars.length;
            ctx.font = `${scalingFactor * r}px bold Calibri, sans-serif`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(badgeChars, location.x - r, location.y - r + g2lz(1));
        }
        if (this.showHighlight) {
            if (bbox === undefined) bbox = this.getBoundingBox();
            ctx.strokeStyle = "red";
            ctx.strokeRect(g2lx(bbox.topLeft.x) - 5, g2ly(bbox.topLeft.y) - 5, g2lz(bbox.w) + 10, g2lz(bbox.h) + 10);
        }
        if (props.isDefeated) {
            if (bbox === undefined) bbox = this.getBoundingBox();
            const crossTL = g2l(bbox.topLeft);
            const crossBR = g2l(bbox.botRight);
            const crossLength = g2lz(Math.max(bbox.w, bbox.h));
            const r = crossLength * 0.2;
            ctx.strokeStyle = "red";
            ctx.fillStyle = props.strokeColour[0]!;
            ctx.lineWidth = r / 5;
            ctx.beginPath();
            ctx.moveTo(crossTL.x + r, crossTL.y + r);
            ctx.lineTo(crossBR.x - r, crossBR.y - r);
            ctx.moveTo(crossTL.x + r, crossBR.y - r);
            ctx.lineTo(crossBR.x - r, crossTL.y + r);
            ctx.stroke();
        }
        // Draw tracker bars
        let barOffset = 0;
        for (const tracker of trackerSystem.getAll(this.id, true)) {
            if (tracker.draw && (tracker.visible || accessSystem.hasAccessTo(this.id, false, { vision: true }))) {
                if (bbox === undefined) bbox = this.getBoundingBox();
                ctx.strokeStyle = "black";
                ctx.lineWidth = g2lz(0.5);
                const topLeft = g2l(bbox.topLeft);
                const botRight = g2l(bbox.botRight);
                const rectX = topLeft.x;
                const rectY = topLeft.y - g2lz(10 + barOffset);
                const rectWidth = botRight.x - topLeft.x; // - g2lz(10);
                const rectHeight = g2lz(5);
                const maxVal = tracker.maxvalue;
                const curVal = clamp(tracker.value, 0, tracker.maxvalue);
                ctx.beginPath();
                ctx.fillStyle = tracker.secondaryColor;
                ctx.fillRect(rectX, rectY, rectWidth, rectHeight);
                ctx.fillStyle = tracker.primaryColor;
                ctx.fillRect(rectX, rectY, rectWidth * (curVal / maxVal), rectHeight);
                ctx.rect(rectX, rectY, rectWidth, rectHeight);
                ctx.stroke();
                barOffset += 10;
            }
        }
    }

    drawSelection(ctx: CanvasRenderingContext2D): void {
        const layer = this.layer;
        if (layer === undefined) return;

        const ogOp = layer.ctx.globalCompositeOperation;
        if (ogOp !== "source-over") layer.ctx.globalCompositeOperation = "source-over";
        const bb = this.getBoundingBox();
        ctx.beginPath();
        ctx.moveTo(g2lx(bb.points[0]![0]), g2ly(bb.points[0]![1]));
        for (let i = 1; i <= bb.points.length; i++) {
            const vertex = bb.points[i % bb.points.length]!;
            ctx.lineTo(g2lx(vertex[0]), g2ly(vertex[1]));
        }
        ctx.stroke();

        const points = this.points; // expensive call
        if (points.length === 0) return; // can trigger mid-floor change

        // Draw vertices
        for (const p of points) {
            ctx.beginPath();
            ctx.arc(g2lx(p[0]), g2ly(p[1]), 3, 0, 2 * Math.PI);
            ctx.fill();
        }

        // Draw edges
        ctx.beginPath();
        ctx.moveTo(g2lx(points[0]![0]), g2ly(points[0]![1]));
        const j = this.isClosed ? 0 : 1;
        for (let i = 1; i <= points.length - j; i++) {
            const vertex = points[i % points.length]!;
            ctx.lineTo(g2lx(vertex[0]), g2ly(vertex[1]));
        }
        ctx.stroke();

        if (ogOp !== "source-over") layer.ctx.globalCompositeOperation = ogOp;
    }

    // VISION

    updateShapeVision(alteredMovement: boolean, alteredVision: boolean): void {
        const props = getProperties(this.id)!;
        if (props.blocksVision && !alteredVision) {
            visionState.deleteFromTriangulation({
                target: TriangulationTarget.VISION,
                shape: this.id,
            });
            visionState.addToTriangulation({ target: TriangulationTarget.VISION, shape: this.id });
            if (this.floorId !== undefined) visionState.recalculateVision(this.floorId);
        }
        this.invalidate(true);
        floorSystem.invalidateLightAllFloors();
        if (props.blocksMovement && !alteredMovement) {
            visionState.deleteFromTriangulation({
                target: TriangulationTarget.MOVEMENT,
                shape: this.id,
            });
            visionState.addToTriangulation({ target: TriangulationTarget.MOVEMENT, shape: this.id });
            if (this.floorId !== undefined) visionState.recalculateMovement(this.floorId);
        }
    }

    // BOUNDING BOX

    getAABB(delta = 0): BoundingRect {
        const points = this.points; // expensive call
        if (points.length === 0) {
            return new BoundingRect(this.refPoint, 5, 5);
        }

        const firstPoint = points[0]!;
        let minx = firstPoint[0];
        let maxx = firstPoint[0];
        let miny = firstPoint[1];
        let maxy = firstPoint[1];
        for (const p of points.slice(1)) {
            if (p[0] < minx) minx = p[0];
            if (p[0] > maxx) maxx = p[0];
            if (p[1] < miny) miny = p[1];
            if (p[1] > maxy) maxy = p[1];
        }
        return new BoundingRect(toGP(minx - delta, miny - delta), maxx - minx + 2 * delta, maxy - miny + 2 * delta);
    }

    getAuraAABB(options?: { onlyVisionSources?: boolean }): BoundingRect {
        let aabb = this.getAABB();
        for (const aura of auraSystem.getAll(this.id, true)) {
            if ((options?.onlyVisionSources ?? false) && !aura.visionSource) continue;
            const range = getUnitDistance(aura.value + aura.dim);
            aabb = aabb.union(new BoundingRect(addP(this.refPoint, new Vector(-range, -range)), range * 2, range * 2));
        }
        return aabb;
    }

    getBoundingBox(delta = 0): BoundingRect {
        return this.getAABB(delta);
    }

    // STATE
    abstract asDict(): ApiShape;

    getBaseDict(): ApiCoreShape {
        const defaultAccess = accessSystem.getDefault(this.id);
        const props = getProperties(this.id)!;
        const annotationInfo = annotationState.get(this.id);
        const uuid = getGlobalId(this.id)!;
        return {
            type_: this.type,
            uuid,
            x: this.refPoint.x,
            y: this.refPoint.y,
            angle: this.angle,
            draw_operator: this.globalCompositeOperation,
            movement_obstruction: props.blocksMovement,
            vision_obstruction: props.blocksVision,
            auras: aurasToServer(uuid, auraSystem.getAll(this.id, false)),
            trackers: trackersToServer(uuid, trackerSystem.getAll(this.id, false)),
            labels: [...labelSystem.getLabels(this.id)],
            owners: accessSystem.getOwnersFull(this.id).map((o) => ownerToServer(o)),
            fill_colour: props.fillColour,
            stroke_colour: props.strokeColour[0]!,
            stroke_width: this.strokeWidth,
            name: props.name,
            name_visible: props.nameVisible,
            annotation: annotationInfo.annotation,
            annotation_visible: annotationInfo.annotationVisible,
            is_token: props.isToken,
            is_invisible: props.isInvisible,
            is_defeated: props.isDefeated,
            options: JSON.stringify(Object.entries(this.options)),
            badge: groupSystem.getBadge(this.id),
            show_badge: props.showBadge,
            is_locked: props.isLocked,
            default_edit_access: defaultAccess.edit,
            default_movement_access: defaultAccess.movement,
            default_vision_access: defaultAccess.vision,
            asset: this.assetId ?? null,
            group: groupSystem.getGroupId(this.id) ?? null,
            ignore_zoom_size: this.ignoreZoomSize,
            is_door: doorSystem.isDoor(this.id),
            is_teleport_zone: teleportZoneSystem.isTeleportZone(this.id),
            character: this.character ?? null,
        };
    }
    fromDict(data: ApiCoreShape): void {
        const options: Partial<ServerShapeOptions> =
            // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
            Object.fromEntries(JSON.parse(data.options));

        this.character = data.character ?? undefined;
        this.angle = data.angle;
        this.globalCompositeOperation = data.draw_operator as GlobalCompositeOperation;

        propertiesSystem.inform(this.id, {
            name: data.name,
            nameVisible: data.name_visible,
            blocksMovement: data.movement_obstruction,
            blocksVision: data.vision_obstruction,
            fillColour: data.fill_colour,
            strokeColour: [data.stroke_colour],
            isToken: data.is_token,
            isInvisible: data.is_invisible,
            isDefeated: data.is_defeated,
            showBadge: data.show_badge,
            isLocked: data.is_locked,
        });

        annotationSystem.inform(this.id, { annotation: data.annotation, annotationVisible: data.annotation_visible });

        const defaultAccess = {
            edit: data.default_edit_access,
            vision: data.default_vision_access,
            movement: data.default_movement_access,
        };
        accessSystem.inform(this.id, {
            default: defaultAccess,
            extra: data.owners.map((owner) => ownerToClient(owner)),
        });
        auraSystem.inform(this.id, aurasFromServer(...data.auras));
        trackerSystem.inform(this.id, trackersFromServer(...data.trackers));
        doorSystem.inform(this.id, data.is_door, options.door);
        teleportZoneSystem.inform(this.id, data.is_teleport_zone, options.teleport);
        labelSystem.inform(this.id, data.labels);
        if (data.character !== null) characterSystem.inform(this.id, data.character);

        this.ignoreZoomSize = data.ignore_zoom_size;

        if (data.options !== undefined) this.options = options;
        if (data.asset !== null) this.assetId = data.asset;
        groupSystem.inform(this.id, { groupId: data.group ?? undefined, badge: data.badge });
    }

    // UTILITY

    visibleInCanvas(max: { w: number; h: number }, options: { includeAuras: boolean }): boolean {
        if (options.includeAuras) {
            for (const aura of auraSystem.getAll(this.id, true)) {
                if (aura.value > 0 || aura.dim > 0) {
                    const r = getUnitDistance(aura.value + aura.dim);
                    const center = this.center;
                    const auraArea = new BoundingRect(toGP(center.x - r, center.y - r), r * 2, r * 2);
                    if (auraArea.visibleInCanvas(max)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }
}
