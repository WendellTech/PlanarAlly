<script setup lang="ts">
import { computed, toRef, watch } from "vue";

import { FULL_SYNC, SERVER_SYNC } from "../../../../core/models/types";
import { useModal } from "../../../../core/plugins/modals/plugin";
import { getChecked, getValue } from "../../../../core/utils";
import { activeShapeStore } from "../../../../store/activeShape";
import { getShape, type LocalId } from "../../../id";
import { setCenterPosition } from "../../../position";
import { accessState } from "../../../systems/access/state";
import { groupSystem } from "../../../systems/groups";
import { CHARACTER_SETS, type CREATION_ORDER_TYPES, CREATION_ORDER_OPTIONS } from "../../../systems/groups/models";
import { groupState } from "../../../systems/groups/state";
import { propertiesSystem } from "../../../systems/properties";
import { getProperties } from "../../../systems/properties/state";

const id = toRef(activeShapeStore.state, "id");

const modals = useModal();

watch(
    () => activeShapeStore.state.id,
    (newId, oldId) => {
        if (newId !== undefined && oldId !== newId) {
            groupSystem.loadState(newId);
        } else if (newId === undefined) {
            groupSystem.dropState();
        }
    },
    { immediate: true },
);

const characterSet = ["numbers", "latin characters", "custom"];
let characterSetSelected = 0;
let customText: string[] = [];
let defaultCreationOrder: CREATION_ORDER_TYPES = "incrementing";

const owned = accessState.hasEditAccess;

const groupMembers = computed(() => {
    const groupId = groupState.reactive.activeGroupId;
    if (groupId === undefined) return [];
    const members = [...(groupState.readonly.groupMembers.get(groupId) ?? [])];
    return members.map((m) => ({ ...groupState.readonly.shapeData.get(m)!, id: m })).sort((a, b) => a.badge - b.badge);
});

function invalidate(): void {
    const shape = getShape(activeShapeStore.state.id!)!;
    shape.invalidate(true);
}

const selectedCharacterSet = computed({
    get() {
        const group = groupState.activeGroup.value;
        if (group === undefined) {
            return characterSetSelected;
        } else {
            const charset = group.characterSet;
            const index = CHARACTER_SETS.findIndex((cs) => cs.join(",") === charset.join(","));
            return index >= 0 ? index : 2;
        }
    },
    set(index: number) {
        if (!owned.value) return;
        const group = groupState.activeGroup.value;

        if (group === undefined) {
            characterSetSelected = index;
        } else {
            if (index === CHARACTER_SETS.length) {
                groupSystem.setCharacterSet(group.uuid, []);
            } else if (index < CHARACTER_SETS.length) {
                groupSystem.setCharacterSet(group.uuid, CHARACTER_SETS[index]!);
                invalidate();
            }
        }
    },
});

const customCharacterSet = computed({
    get() {
        const group = groupState.activeGroup.value;
        if (group === undefined) {
            return customText.join(",");
        }
        return group.characterSet.join(",");
    },
    set(characterSet: string) {
        if (!owned.value) return;
        const group = groupState.activeGroup.value;

        const value = characterSet.split(",");
        if (group === undefined) {
            customText = value;
        } else {
            groupSystem.setCharacterSet(group.uuid, value);
            invalidate();
        }
    },
});

const creationOrder = computed(() => {
    const group = groupState.activeGroup.value;
    if (group === undefined) {
        return defaultCreationOrder;
    }
    return group.creationOrder;
});

async function _setCreationOrder(order: CREATION_ORDER_TYPES): Promise<void> {
    if (!owned.value) return;
    const group = groupState.activeGroup.value;

    if (group === undefined) {
        defaultCreationOrder = order;
    } else {
        const doChange = await modals.confirm(
            "Changing creation order",
            "Are you sure you wish to change the creation order? This will change all badges in this group.",
        );
        if (doChange === true) {
            groupSystem.setCreationOrder(group.uuid, order);
            invalidate();
        }
    }
}

function updateToggles(checked: boolean): void {
    if (!owned.value) return;
    for (const member of groupMembers.value) {
        if (getProperties(member.id)?.showBadge !== checked)
            propertiesSystem.setShowBadge(member.id, checked, SERVER_SYNC);
    }
}

function centerMember(member: LocalId): void {
    if (!owned.value) return;
    const shape = getShape(member);
    if (shape) setCenterPosition(shape.center);
}

function toggleHighlight(member: LocalId, show: boolean): void {
    if (!owned.value) return;
    const shape = getShape(member);
    if (shape) {
        shape.showHighlight = show;
        shape.layer?.invalidate(true);
    }
}

function showBadge(member: LocalId, checked: boolean): void {
    if (!owned.value) return;
    propertiesSystem.setShowBadge(member, checked, FULL_SYNC);
}

function removeMember(memberId: LocalId): void {
    if (!owned.value) return;
    groupSystem.removeGroupMember(memberId, true);
}

function createGroup(): void {
    if (!owned.value) return;
    if (groupState.reactive.activeGroupId !== undefined || id.value === undefined) return;
    groupSystem.createNewGroupForShapes([id.value]);
}

async function deleteGroup(): Promise<void> {
    if (!owned.value) return;
    const groupId = groupState.reactive.activeGroupId;
    if (groupId === undefined) return;

    const remove = await modals.confirm(
        "Removing group",
        "Are you sure you wish to remove this group. There might be shapes in other locations that are associated with this group as well.",
    );
    if (remove === true) {
        groupSystem.removeGroup(groupId, true);
    }
}
</script>

<template>
    <div class="panel restore-panel">
        <div class="spanrow header">Rules</div>
        <div class="rule">Character set</div>
        <div class="selection-box">
            <template v-for="(cs, i) of characterSet" :key="cs">
                <div :class="{ 'selection-box-active': i === selectedCharacterSet }" @click="selectedCharacterSet = i">
                    {{ cs }}
                </div>
            </template>
        </div>
        <template v-if="selectedCharacterSet === 2">
            <div class="rule">Custom charset</div>
            <div style="grid-column: fill/end">
                <input
                    type="text"
                    :value="customCharacterSet"
                    placeholder="α,β,γ,δ,ε"
                    @change="customCharacterSet = getValue($event)"
                />
            </div>
        </template>
        <div class="rule">Creation order</div>
        <div class="selection-box">
            <template v-for="co of CREATION_ORDER_OPTIONS" :key="co">
                <div :class="{ 'selection-box-active': co === creationOrder }" @click="_setCreationOrder(co)">
                    {{ co }}
                </div>
            </template>
        </div>
        <template v-if="groupState.reactive.activeId !== undefined">
            <div class="spanrow header">Members</div>
            <label class="rule" style="grid-column: badge/toggle" for="toggleCheckbox">
                Show badge on all members:
            </label>
            <div>
                <input
                    id="toggleCheckbox"
                    ref="toggleCheckbox"
                    type="checkbox"
                    @click="updateToggles(getChecked($event))"
                />
            </div>
            <div></div>
            <div class="subheader">Badge</div>
            <div></div>
            <div class="subheader">Show Badge</div>
            <div class="subheader">Remove</div>
            <template v-for="member of groupMembers" :key="member.id">
                <div
                    class="badge"
                    title="Center on this member"
                    @click="centerMember(member.id)"
                    @mouseenter="toggleHighlight(member.id, true)"
                    @mouseleave="toggleHighlight(member.id, false)"
                >
                    <template v-if="member.id === id">></template>
                    {{ groupSystem.getBadgeCharacters(member.id) }}
                    <template v-if="member.id === id">&lt;</template>
                </div>
                <div></div>
                <div>
                    <input
                        type="checkbox"
                        :checked="getProperties(member.id)!.showBadge"
                        @click="showBadge(member.id, getChecked($event))"
                    />
                </div>
                <div :style="{ textAlign: 'center' }">
                    <font-awesome-icon icon="trash-alt" @click="removeMember(member.id)" />
                </div>
            </template>
        </template>
        <template v-if="groupState.reactive.activeGroupId === undefined">
            <div class="spanrow header">Actions</div>
            <div></div>
            <div></div>
            <div></div>
            <div style="grid-column: toggle/end">
                <button class="danger" @click="createGroup">Create new group</button>
            </div>
        </template>
        <template v-else>
            <div class="spanrow header">Danger Zone</div>
            <div></div>
            <div></div>
            <div style="grid-column: toggle/end"><button class="danger" @click="deleteGroup">Delete group</button></div>
        </template>
    </div>
</template>

<style scoped lang="scss">
.panel {
    grid-template-columns: [badge] 1fr [fill] auto [toggle] 100px [remove] 50px [end];
    grid-column-gap: 10px;
    align-items: center;
    padding-bottom: 1em;
    justify-items: center;
    overflow: auto;
    max-height: 65vh;
}

input[type="text"] {
    padding: 2px;
}

.rule {
    justify-self: normal;
}

.subheader {
    text-decoration: underline;
}

.badge:hover {
    cursor: pointer;
}

.selection-box {
    display: flex;
    flex-direction: row;
    grid-column: fill / end;

    > div {
        border: solid 1px;
        border-left: 0;
        padding: 7px;

        &:first-child {
            border: solid 1px;
            border-top-left-radius: 8px;
            border-bottom-left-radius: 8px;
        }

        &:last-child {
            border-top-right-radius: 8px;
            border-bottom-right-radius: 8px;
        }
    }
}

.selection-box > div:hover,
.selection-box-active {
    background-color: #82c8a0;
    cursor: pointer;
}
</style>
