<script setup lang="ts">
import { type Component, computed } from "vue";
import { useI18n } from "vue-i18n";

import PanelModal from "../../../../core/components/modals/PanelModal.vue";
import { uiSystem } from "../../../systems/ui";
import { uiState } from "../../../systems/ui/state";
import FloorSettings from "../location/FloorSettings.vue";
import GridSettings from "../location/GridSettings.vue";
import VariaSettings from "../location/VariaSettings.vue";
import VisionSettings from "../location/VisionSettings.vue";

import AdminSettings from "./AdminSettings.vue";
import { DmSettingCategory } from "./categories";

const { t } = useI18n();

const visible = computed({
    get() {
        return uiState.reactive.showDmSettings;
    },
    set(visible: boolean) {
        uiSystem.showDmSettings(visible);
    },
});

function close(): void {
    visible.value = false;
}
defineExpose({ close });

const tabs: { name: string; component: Component; props: { global: true } }[] = [
    { name: t(DmSettingCategory.Admin), component: AdminSettings, props: { global: true } },
    { name: t(DmSettingCategory.Grid), component: GridSettings, props: { global: true } },
    { name: t(DmSettingCategory.Vision), component: VisionSettings, props: { global: true } },
    { name: t(DmSettingCategory.Floor), component: FloorSettings, props: { global: true } },
    { name: t(DmSettingCategory.Varia), component: VariaSettings, props: { global: true } },
];
</script>

<template>
    <PanelModal v-model:visible="visible" :tabs="tabs">
        <template #title>{{ t("game.ui.settings.dm.DmSettings.dm_settings") }}</template>
    </PanelModal>
</template>
