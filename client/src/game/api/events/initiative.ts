import { InitiativeData, InitiativeEffect } from "../../models/general";
import { initiativeStore } from "../../ui/initiative/state";
import { socket } from "../socket";

socket.on("Initiative.Set", (data: { location: number; round: number; turn: number; data: InitiativeData[] }) =>
    initiativeStore.setData(data),
);

socket.on("Initiative.Remove", (data: string) => initiativeStore.removeInitiative(data, false));

socket.on("Initiative.Turn.Update", (turn: number) => initiativeStore.setTurnCounter(turn, false));
socket.on("Initiative.Round.Update", (round: number) => initiativeStore.setRoundCounter(round, false));
socket.on("Initiative.Effect.New", (data: { actor: string; effect: InitiativeEffect }) => {
    initiativeStore.createEffect(data.actor, data.effect, false);
});
socket.on("Initiative.Effect.Rename", (data: { shape: string; index: number; name: string }) => {
    initiativeStore.setEffectName(data.shape, data.index, data.name, false);
});
socket.on("Initiative.Effect.Turns", (data: { shape: string; index: number; turns: string }) => {
    initiativeStore.setEffectTurns(data.shape, data.index, data.turns, false);
});
socket.on("Initiative.Effect.Remove", (data: { shape: string; index: number }) =>
    initiativeStore.removeEffect(data.shape, data.index, false),
);
socket.on("Initiative.Option.Set", (data: { shape: string; option: "isVisible" | "isGroup"; value: boolean }) =>
    initiativeStore.setOption(data.shape, data.option, data.value),
);
socket.on("Initiative.Request", () => {
    initiativeStore.handleRequest();
});
