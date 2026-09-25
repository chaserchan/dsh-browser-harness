/**
 * dsh-browser-harness —— client（web）半边：设置菜单栏。
 *
 * 在「设置 → 通用设置」注册「浏览器自动化」配置区：
 *   - TypeSafe API Key   —— 有值才启用 browser_autopilot（Jev 目标式自动化）
 *   - Text Model API Key —— 可选，Jev 兜底文本模型（OpenAI 兼容端点）
 *
 * 保存到 host 侧注册的 settings namespace `browser-harness`（热加载，
 * 保存即生效，无需重启）。模式照搬 dsh-plugin-global-prompt 的成熟实现。
 */

window.__ModuleLoader__.load({
	id: "dsh-browser-harness",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");

		//#region css
		const css = ".bhk-row{border-bottom:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:6px;padding:16px 0;display:flex}.bhk-head{align-items:center;gap:12px;min-width:0;display:flex}.bhk-title{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}.bhk-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.bhk-field{flex-direction:column;gap:4px;display:flex;margin-top:8px}.bhk-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.bhk-input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);width:100%;color:var(--dsw-alias-label-primary);border-radius:8px;margin:0;padding:8px 12px;font:inherit;font-size:13px;line-height:1.5}.bhk-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}.bhk-status{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.bhk-status-error{color:var(--dsw-alias-state-error-primary)}";
		const tagId = "dsh-browser-harness/BrowserHarnessSettings.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-browser-harness";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		/** Locale namespace owning this row's copy. */
		const NS = "settings.browser-harness";
		/** Settings namespace registered by the host half. */
		const SETTINGS_NAMESPACE = "browser-harness";
		/** Autosave quiet window after the last keystroke. */
		const SAVE_DEBOUNCE_MS = 600;
		/** Key fields rendered in this row, in order. */
		const FIELDS = [
			{ key: "typesafeKey", labelKey: "typesafeTitle", hintKey: "typesafeHint", placeholderKey: "placeholder" },
			{ key: "textModelKey", labelKey: "textModelTitle", hintKey: "textModelHint", placeholderKey: "placeholder" },
		];

		/** Simplified Chinese dictionary (key-set source of truth). */
		const zh = {
			title: "浏览器自动化",
			typesafeTitle: "TypeSafe API Key",
			typesafeHint: "配置后启用目标式自动化 browser_autopilot（Jev，读页面自主完成任务）；留空则不启用。",
			textModelTitle: "Text Model API Key",
			textModelHint: "可选。Jev 兜底文本模型的 OpenAI 兼容 key（如 DeepSeek）。不填则仅用 TypeSafe key。",
			placeholder: "粘贴 key，保存后立即生效",
			saved: "已保存",
			saving: "保存中…",
			error: "保存失败",
		};
		/** English dictionary, checked complete against the zh key set. */
		const en = {
			title: "Browser automation",
			typesafeTitle: "TypeSafe API key",
			typesafeHint: "When set, enables the goal-driven browser_autopilot tool (Jev). Leave empty to disable.",
			textModelTitle: "Text model API key",
			textModelHint: "Optional. OpenAI-compatible key for Jev's fallback text model (e.g. DeepSeek).",
			placeholder: "Paste key; takes effect immediately after saving",
			saved: "Saved",
			saving: "Saving…",
			error: "Failed to save",
		};

		/**
		 * One password input bound to a single settings field; autosaves
		 * (debounced) through the row's save action.
		 */
		function KeyField({ t, label, hint, value, onSave }) {
			const [draft, setDraft] = react.useState(value);
			const [status, setStatus] = react.useState("idle");
			const [error, setError] = react.useState(null);
			const draftRef = react.useRef(value);
			const timerRef = react.useRef(null);

			// Adopt externally changed persisted value only when no local edit is pending.
			react.useEffect(() => {
				if (draftRef.current === value) return;
				draftRef.current = value;
				setDraft(value);
			}, [value]);

			react.useEffect(() => () => {
				if (timerRef.current !== null) clearTimeout(timerRef.current);
			}, []);

			const handleChange = (event) => {
				const next = event.target.value;
				draftRef.current = next;
				setDraft(next);
				setStatus("saving");
				setError(null);
				if (timerRef.current !== null) clearTimeout(timerRef.current);
				timerRef.current = setTimeout(() => {
					timerRef.current = null;
					Promise.resolve().then(() => onSave(next)).then(() => {
						setStatus("saved");
					}, (cause) => {
						setStatus("error");
						setError(cause instanceof Error ? cause.message : String(cause));
					});
				}, SAVE_DEBOUNCE_MS);
			};

			const statusText = status === "saved" ? t("saved") : status === "saving" ? t("saving") : status === "error" ? t("error") : "";
			return react_jsx_runtime.jsxs("div", {
				className: "bhk-field",
				children: [
					react_jsx_runtime.jsx("span", { className: "bhk-label", children: label }),
					react_jsx_runtime.jsx("div", { className: "bhk-hint", children: hint }),
					react_jsx_runtime.jsx("input", {
						className: "bhk-input",
						type: "password",
						value: draft,
						onChange: handleChange,
						spellCheck: false,
						autoComplete: "off",
						"aria-label": label,
						placeholder: t("placeholder"),
					}),
					statusText.length === 0 ? null : react_jsx_runtime.jsx("div", {
						className: "bhk-status" + (status === "error" ? " bhk-status-error" : ""),
						role: status === "error" ? "alert" : void 0,
						children: status === "error" && error !== null ? statusText + ": " + error : statusText,
					}),
				],
			});
		}

		/** 「浏览器自动化」设置行：标题 + 两个 key 输入框（debounce 保存）。 */
		function BrowserHarnessRow({ t, useStore, save }) {
			const persisted = useStore((s) => s);
			return react_jsx_runtime.jsxs("div", {
				className: "bhk-row",
				children: [
					react_jsx_runtime.jsx("div", { className: "bhk-head", children: react_jsx_runtime.jsx("span", { className: "bhk-title", children: t("title") }) }),
					react_jsx_runtime.jsx("div", { className: "bhk-hint", children: t("typesafeHint") }),
					FIELDS.map((f) => react_jsx_runtime.jsx(KeyField, {
						t,
						label: t(f.labelKey),
						hint: t(f.hintKey),
						value: persisted[f.key] ?? "",
						onSave: (v) => save(f.key, v),
					}, f.key)),
				],
			});
		}

		/** Row store: a mirror of the settings scope's resolved value. */
		function createBrowserHarnessStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({ typesafeKey: "", textModelKey: "" }),
				actions: { sync: (d, value) => {
					d.typesafeKey = value?.typesafeKey ?? "";
					d.textModelKey = value?.textModelKey ?? "";
				} },
			});
		}

		/** Required services (cordis fiber inject). */
		// 0.1.7 起 client settingsScope 服务被移除（settings 体系重构为 ConfigForms）。
		// key 保存通道暂由环境变量兜底（host 侧 readKeys 支持 TYPESAFE_API_KEY / TEXT_MODEL_API_KEY）。
		const inject = ["slots", "locale"];

		/**
		 * Register the feature-owned browser automation row into the General
		 * section's item slot once the slot declaration is on the ledger.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			// 0.1.7 settings 体系重构（ConfigForms）：设置行整体暂停。
			// 注意：不能访问任何未在 inject 声明的服务属性 —— cordis client ctx
			// 是严格 proxy，读未声明属性直接抛错（会把整个插件打成 failed）。
			// key 配置请用环境变量 TYPESAFE_API_KEY / TEXT_MODEL_API_KEY（host 侧实时读取，立即生效）。
			if (typeof console !== "undefined") {
				console.warn("[dsh-browser-harness] client: 0.1.7 设置行暂未适配（settings 体系重构为 ConfigForms），TypeSafe key 请用环境变量 TYPESAFE_API_KEY 配置。");
			}
			return;
		}

		/**
		 * （0.1.6 及以下可用的原始实现，待 ConfigForms 适配后恢复 —— 见 git 0.4.2）
		 * Register the feature-owned browser automation row (settingsScope 版)。
		 */
		function applyLegacySettingsScope(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "browser-harness: dictionaries");
			const t = ctx.locale.bind(NS);
			const scope = ctx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
			const store = createBrowserHarnessStore();
			let bound;
			const reflect = (snapshot) => {
				if (snapshot !== void 0 && snapshot !== null && snapshot.status === "ready" && snapshot.value !== void 0) {
					bound?.sync(snapshot.value);
				}
			};
			ctx.effect(() => scope.subscribe(reflect), "browser-harness: settings scope adoption");
			reflect(scope.getSnapshot());
			ctx.slots.inject("settings.general.item", () => ctx.slots.register({
				name: "settings.general.item",
				id: "browser-harness",
				order: 11,
				store,
				locale: NS,
				inject: (actions) => {
					bound = actions;
					reflect(scope.getSnapshot());
					return { save: (field, value) => scope.set(field, value) };
				},
			}, BrowserHarnessRow));
		}

		exports.apply = apply;
		exports.applyLegacySettingsScope = applyLegacySettingsScope;
		exports.inject = inject;
		return module.exports;
	},
});
