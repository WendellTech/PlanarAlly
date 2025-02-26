/// <reference types="vitest" />

import { fileURLToPath, URL } from "node:url";

import path from "path";
import { defineConfig, loadEnv } from "vite";
import EsmExternals from "@esbuild-plugins/esm-externals";
import vue from "@vitejs/plugin-vue";
import vueI18n from "@intlify/unplugin-vue-i18n/vite";
import { transformLazyShow } from "v-lazy-show";
import { ViteEjsPlugin } from "vite-plugin-ejs";

const viteEnv = loadEnv(process.env.NODE_ENV ?? "production", process.cwd());

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [
        vue({ template: { compilerOptions: { nodeTransforms: [transformLazyShow] } } }),
        vueI18n({
            include: path.resolve(__dirname, "./src/locales/**"),
        }),
        ViteEjsPlugin({
            localVue: viteEnv.VITE_VUE_URL.startsWith("."),
            vueUrl: viteEnv.VITE_VUE_URL.replace("../server/", ""),
        }),
    ],
    server: {
        host: "0.0.0.0",
        port: 8080,
        hmr: {
            port: 9324,
        },
        fs: {
            strict: false,
        },
    },
    base: process.env.PA_BASEPATH,
    build: {
        minify: "esbuild",
        assetsDir: process.env.NODE_ENV === "production" ? "static/vite" : "dev-static",
        outDir: "../server",
        chunkSizeWarningLimit: 2500,
        rollupOptions: {
            external: ["ammo.js", "vue"],
            output: { globals: { vue: "Vue" } },
        },
        commonjsOptions: {
            esmExternals: true,
        },
    },
    optimizeDeps: {
        esbuildOptions: {
            plugins: [EsmExternals({ externals: ["vue"] })],
        },
    },
    resolve: {
        alias: [
            {
                find: new RegExp("^vue$"),
                replacement: viteEnv.VITE_VUE_URL.startsWith(".")
                    ? fileURLToPath(new URL(viteEnv.VITE_VUE_URL, import.meta.url))
                    : viteEnv.VITE_VUE_URL,
            },
        ],
    },
    css: { preprocessorOptions: { scss: { charset: false } } },
    test: {
        environment: "happy-dom",
        setupFiles: ["./test/setup.ts"],
        coverage: {
            reporter: ["text", "html"],
        },
    },
});
