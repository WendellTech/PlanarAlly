import type {
    ApiAssetRectShape,
    ApiCircleShape,
    ApiCircularTokenShape,
    ApiLineShape,
    ApiPolygonShape,
    ApiRectShape,
    ApiShape,
    ApiTextShape,
    ApiToggleCompositeShape,
} from "../../apiTypes";
import { toGP } from "../../core/geometry";
import { baseAdjust } from "../../core/http";
import { reserveLocalId, getLocalId } from "../id";
import type { IShape } from "../interfaces/shape";
import type { FloorId, LayerName } from "../models/floor";
import { groupSystem } from "../systems/groups";

import { Asset } from "./variants/asset";
import { Circle } from "./variants/circle";
import { CircularToken } from "./variants/circularToken";
import { Line } from "./variants/line";
import { Polygon } from "./variants/polygon";
import { Rect } from "./variants/rect";
import { Text } from "./variants/text";
import { ToggleComposite } from "./variants/toggleComposite";

export function createShapeFromDict(shape: ApiShape, floor: FloorId, layerName: LayerName): IShape | undefined {
    let sh: IShape;

    const uuid = shape.uuid;

    // A fromJSON and toJSON on Shape would be cleaner but ts does not allow for static abstracts so yeah.

    if (shape.group !== undefined && shape.group !== null) {
        const group = groupSystem.hasGroup(shape.group);
        if (group === undefined) {
            console.log("Missing group info detected");
        } else {
            groupSystem.addGroupMembers(shape.group, [{ uuid: reserveLocalId(uuid), badge: shape.badge }], false);
        }
    }

    // Shape Type specifics

    try {
        const refPoint = toGP(shape.x, shape.y);
        if (shape.type_ === "rect") {
            const rect = shape as ApiRectShape;
            sh = new Rect(refPoint, rect.width, rect.height, {
                uuid,
            });
        } else if (shape.type_ === "circle") {
            const circ = shape as ApiCircleShape;
            sh = new Circle(refPoint, circ.radius, {
                uuid,
            });
        } else if (shape.type_ === "circulartoken") {
            const token = shape as ApiCircularTokenShape;
            sh = new CircularToken(refPoint, token.radius, token.text, token.font, {
                uuid,
            });
        } else if (shape.type_ === "line") {
            const line = shape as ApiLineShape;
            sh = new Line(refPoint, toGP(line.x2, line.y2), {
                lineWidth: line.line_width,
                uuid,
            });
        } else if (shape.type_ === "polygon") {
            const polygon = shape as ApiPolygonShape;
            const vertices = JSON.parse(polygon.vertices) as [number, number][];
            sh = new Polygon(
                refPoint,
                vertices.map((v) => toGP(v)),
                {
                    lineWidth: [polygon.line_width],
                    openPolygon: polygon.open_polygon,
                    uuid,
                },
            );
        } else if (shape.type_ === "text") {
            const text = shape as ApiTextShape;
            sh = new Text(refPoint, text.text, text.font_size, {
                uuid,
            });
        } else if (shape.type_ === "assetrect") {
            const asset = shape as ApiAssetRectShape;
            const img = new Image(asset.width, asset.height);
            if (asset.src.startsWith("http")) img.src = baseAdjust(new URL(asset.src).pathname);
            else img.src = baseAdjust(asset.src);
            sh = new Asset(img, refPoint, asset.width, asset.height, { uuid, loaded: false });
            img.onload = () => {
                (sh as Asset).setLoaded();
            };
        } else if (shape.type_ === "togglecomposite") {
            const toggleComposite = shape as ApiToggleCompositeShape;

            if (toggleComposite.active_variant === null)
                throw new Error("ToggleComposite with no active variant found");

            sh = new ToggleComposite(
                refPoint,
                getLocalId(toggleComposite.active_variant)!,
                toggleComposite.variants.map((v) => ({ id: reserveLocalId(v.uuid), name: v.name })),
                {
                    uuid,
                },
            );
        } else {
            console.error(`Failed to create Shape with unknown type ${shape.type_}`);
            return undefined;
        }
    } catch (exception) {
        console.error(`Failed to create Shape of type ${shape.type_}`);
        console.error(exception);
        return undefined;
    }

    sh.setLayer(floor, layerName);
    sh.fromDict(shape);
    return sh;
}
