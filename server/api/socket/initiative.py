import json
from operator import itemgetter
from typing import List, Optional
from typing_extensions import TypedDict

from playhouse.shortcuts import dict_to_model, update_model_from_dict

import auth
from api.socket.constants import GAME_NS
from app import app, sio
from models import (
    Initiative,
    PlayerRoom,
    Shape,
)
from models.db import db
from models.role import Role
from models.shape.access import has_ownership
from models.utils import reduce_data_to_model
from state.game import game_state
from utils import logger


class ServerInitiativeEffect(TypedDict):
    name: str
    turns: int
    highlightsActor: bool


class ServerInitiativeOption(TypedDict):
    shape: str
    option: str
    value: bool


class ServerInitiativeData(TypedDict):
    shape: str
    initiative: Optional[int]
    isVisible: bool
    isGroup: bool
    effects: List[ServerInitiativeEffect]


class ServerInitiativeEffectActor(TypedDict):
    actor: str
    effect: ServerInitiativeEffect


class ServerRenameInitiativeEffect(TypedDict):
    shape: str
    index: int
    name: str


class ServerInitiativeEffectTurns(TypedDict):
    shape: str
    index: int
    turns: str


class ServerRemoveInitiativeEffectActor(TypedDict):
    shape: str
    index: int


@sio.on("Initiative.Request", namespace=GAME_NS)
@auth.login_required(app, sio)
async def request_initiatives(sid: str):
    pr: PlayerRoom = game_state.get(sid)

    await sio.emit(
        "Initiative.Request",
        skip_sid=sid,
        room=pr.active_location.get_path(),
        namespace=GAME_NS,
    )


@sio.on("Initiative.Option.Update", namespace=GAME_NS)
@auth.login_required(app, sio)
async def update_initiative_option(sid: str, data: ServerInitiativeOption):
    pr: PlayerRoom = game_state.get(sid)

    shape = Shape.get_or_none(uuid=data["shape"])

    if not has_ownership(shape, pr):
        logger.warning(
            f"{pr.player.name} attempted to change initiative of an asset it does not own"
        )
        return

    location_data = Initiative.get_or_none(location=pr.active_location)
    if location_data is None:
        logger.error("Initiative updated for location without initiative tracking")
        return

    json_data = json.loads(location_data.data)

    with db.atomic():
        for i, initiative_data in enumerate(json_data):
            if initiative_data["shape"] == data["shape"]:
                json_data[i][data["option"]] = data["value"]
                break

        location_data.data = json.dumps(json_data)
        location_data.save()

    await sio.emit(
        "Initiative.Option.Set",
        data,
        skip_sid=sid,
        room=pr.active_location.get_path(),
        namespace=GAME_NS,
    )


@sio.on("Initiative.Add", namespace=GAME_NS)
@auth.login_required(app, sio)
async def add_initiative(sid: str, data: ServerInitiativeData):
    pr: PlayerRoom = game_state.get(sid)

    shape = Shape.get_or_none(uuid=data)

    if shape is not None and not has_ownership(shape, pr):
        logger.warning(
            f"{pr.player.name} attempted to remove initiative of an asset it does not own"
        )
        return

    with db.atomic():
        location_data = Initiative.get(location=pr.active_location)
        json_data = json.loads(location_data.data)

        for initiative in json_data:
            if initiative["shape"] == data["shape"]:
                initiative.update(**data)
                break
        else:
            json_data.append(data)

        json_data.sort(key=itemgetter("initiative"), reverse=True)

        location_data.data = json.dumps(json_data)
        location_data.save()

    await sio.emit(
        "Initiative.Set",
        location_data.as_dict(),
        room=pr.active_location.get_path(),
        namespace=GAME_NS,
    )


@sio.on("Initiative.Remove", namespace=GAME_NS)
@auth.login_required(app, sio)
async def remove_initiative(sid: str, data: str):
    pr: PlayerRoom = game_state.get(sid)

    shape = Shape.get_or_none(uuid=data)

    if shape is not None and not has_ownership(shape, pr):
        logger.warning(
            f"{pr.player.name} attempted to remove initiative of an asset it does not own"
        )
        return

    with db.atomic():
        location_data = Initiative.get(location=pr.active_location)
        json_data = json.loads(location_data.data)
        location_data.data = json.dumps(
            [initiative for initiative in json_data if initiative["shape"] != data]
        )
        location_data.save()

    await sio.emit(
        "Initiative.Remove",
        data,
        room=pr.active_location.get_path(),
        skip_sid=sid,
        namespace=GAME_NS,
    )


@sio.on("Initiative.Turn.Update", namespace=GAME_NS)
@auth.login_required(app, sio)
async def update_initiative_turn(sid: str, turn: int):
    pr: PlayerRoom = game_state.get(sid)

    if pr.role != Role.DM:
        logger.warning(f"{pr.player.name} attempted to advance the initiative tracker")
        return

    location_data = Initiative.get(location=pr.active_location)
    with db.atomic():
        nextTurn = turn > location_data.turn
        location_data.turn = turn

        json_data = json.loads(location_data.data)

        for i, effect in enumerate(json_data[turn]["effects"][-1:]):
            try:
                turns = int(effect["turns"])
                if turns <= 0 and nextTurn:
                    json_data[turn]["effects"].pop(i)
                elif turns > 0 and nextTurn:
                    effect["turns"] = str(turns - 1)
                else:
                    effect["turns"] = str(turns + 1)
            except ValueError:
                # For non-number inputs do not update the effect
                pass

        location_data.data = json.dumps(json_data)

        location_data.save()

    await sio.emit(
        "Initiative.Turn.Update",
        turn,
        room=pr.active_location.get_path(),
        skip_sid=sid,
        namespace=GAME_NS,
    )


@sio.on("Initiative.Round.Update", namespace=GAME_NS)
@auth.login_required(app, sio)
async def update_initiative_round(sid: str, data: int):
    pr: PlayerRoom = game_state.get(sid)

    if pr.role != Role.DM:
        logger.warning(f"{pr.player.name} attempted to advance the initiative tracker")
        return

    location_data = Initiative.get(location=pr.active_location)
    with db.atomic():
        location_data.round = data
        location_data.save()

    await sio.emit(
        "Initiative.Round.Update",
        data,
        room=pr.active_location.get_path(),
        skip_sid=sid,
        namespace=GAME_NS,
    )


@sio.on("Initiative.Effect.New", namespace=GAME_NS)
@auth.login_required(app, sio)
async def new_initiative_effect(sid: str, data: ServerInitiativeEffectActor):
    pr: PlayerRoom = game_state.get(sid)

    if not has_ownership(Shape.get_or_none(uuid=data["actor"]), pr):
        logger.warning(f"{pr.player.name} attempted to create a new initiative effect")
        return

    location_data = Initiative.get(location=pr.active_location)
    with db.atomic():
        json_data = json.loads(location_data.data)

        for initiative in json_data:
            if initiative["shape"] == data["actor"]:
                initiative["effects"].append(data["effect"])

        location_data.data = json.dumps(json_data)
        location_data.save()

    await sio.emit(
        "Initiative.Effect.New",
        data,
        room=pr.active_location.get_path(),
        skip_sid=sid,
        namespace=GAME_NS,
    )


@sio.on("Initiative.Effect.Rename", namespace=GAME_NS)
@auth.login_required(app, sio)
async def rename_initiative_effect(sid: str, data: ServerRenameInitiativeEffect):
    pr: PlayerRoom = game_state.get(sid)

    if not has_ownership(Shape.get_or_none(uuid=data["shape"]), pr):
        logger.warning(f"{pr.player.name} attempted to create a new initiative effect")
        return

    location_data = Initiative.get(location=pr.active_location)
    with db.atomic():
        json_data = json.loads(location_data.data)

        for initiative in json_data:
            if initiative["shape"] == data["shape"]:
                initiative["effects"][data["index"]]["name"] = data["name"]

        location_data.data = json.dumps(json_data)
        location_data.save()

    await sio.emit(
        "Initiative.Effect.Rename",
        data,
        room=pr.active_location.get_path(),
        skip_sid=sid,
        namespace=GAME_NS,
    )


@sio.on("Initiative.Effect.Turns", namespace=GAME_NS)
@auth.login_required(app, sio)
async def set_initiative_effect_tuns(sid: str, data: ServerInitiativeEffectTurns):
    pr: PlayerRoom = game_state.get(sid)

    if not has_ownership(Shape.get_or_none(uuid=data["shape"]), pr):
        logger.warning(f"{pr.player.name} attempted to create a new initiative effect")
        return

    location_data = Initiative.get(location=pr.active_location)
    with db.atomic():
        json_data = json.loads(location_data.data)

        for initiative in json_data:
            if initiative["shape"] == data["shape"]:
                initiative["effects"][data["index"]]["turns"] = data["turns"]

        location_data.data = json.dumps(json_data)
        location_data.save()

    await sio.emit(
        "Initiative.Effect.Turns",
        data,
        room=pr.active_location.get_path(),
        skip_sid=sid,
        namespace=GAME_NS,
    )


@sio.on("Initiative.Effect.Remove", namespace=GAME_NS)
@auth.login_required(app, sio)
async def remove_initiative_effect(sid: str, data: ServerRemoveInitiativeEffectActor):
    pr: PlayerRoom = game_state.get(sid)

    if not has_ownership(Shape.get_or_none(uuid=data["shape"]), pr):
        logger.warning(f"{pr.player.name} attempted to remove an initiative effect")
        return

    location_data = Initiative.get(location=pr.active_location)
    with db.atomic():
        json_data = json.loads(location_data.data)

        for initiative in json_data:
            if initiative["shape"] == data["shape"]:
                initiative["effects"].pop(data["index"])

        location_data.data = json.dumps(json_data)
        location_data.save()

    await sio.emit(
        "Initiative.Effect.Remove",
        data,
        room=pr.active_location.get_path(),
        skip_sid=sid,
        namespace=GAME_NS,
    )
