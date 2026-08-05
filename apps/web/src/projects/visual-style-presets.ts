export const VISUAL_STYLE_PRESETS = [
  { id: "realistic", label: "写实摄影", description: "真实材质与自然光，画面可信，保持摄影质感。" },
  { id: "cinematic", label: "电影纪实", description: "电影级光影与克制调色，真实环境细节，中等景深。" },
  { id: "anime", label: "日系动漫", description: "精致二维赛璐璐，清晰线条与层次光影，避免真人质感。" },
  { id: "chinese", label: "国风插画", description: "当代国风插画，含蓄色彩与水墨肌理，主体清晰。" },
  { id: "vector", label: "扁平矢量", description: "简洁几何造型、纯色色块、清晰轮廓与信息图式构图。" },
  { id: "line-art", label: "手绘线稿", description: "黑白手绘线稿，结构准确、疏密有序，辅以少量灰度阴影。" },
  { id: "3d-cartoon", label: "3D 卡通", description: "风格化三维角色与场景，柔和布光，圆润材质，空间层次清楚。" },
  { id: "retro-collage", label: "复古拼贴", description: "复古印刷色、颗粒肌理与拼贴构图，保留清楚的视觉焦点。" },
] as const;

export type VisualStylePresetId = typeof VISUAL_STYLE_PRESETS[number]["id"];

const visualStyleLinePattern = /^【画风预设：([^】\r\n]+)】[^\r\n]*(?:\r?\n)?/u;

export function selectedVisualStylePreset(value: string): VisualStylePresetId | null {
  const label = value.match(visualStyleLinePattern)?.[1];
  return VISUAL_STYLE_PRESETS.find((preset) => preset.label === label)?.id ?? null;
}

export function applyVisualStylePreset(value: string, presetId: VisualStylePresetId | null) {
  const customInstructions = value.replace(visualStyleLinePattern, "");
  const preset = VISUAL_STYLE_PRESETS.find((item) => item.id === presetId);
  return preset
    ? `【画风预设：${preset.label}】${preset.description}${customInstructions ? `\n${customInstructions}` : ""}`
    : customInstructions;
}

export function promptInstructionsStatus(scriptInstructions: string, visualInstructions: string) {
  const preset = VISUAL_STYLE_PRESETS.find((item) => item.id === selectedVisualStylePreset(visualInstructions));
  const configured = [scriptInstructions.trim() && "文案", visualInstructions.trim() && (preset ? `画面（${preset.label}）` : "画面")].filter(Boolean);
  return configured.length ? `已设置：${configured.join("、")}` : "未设置";
}
