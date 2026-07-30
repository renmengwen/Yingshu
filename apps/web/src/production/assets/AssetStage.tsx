import { AssetLibrary } from "./AssetLibrary";
import { CandidatePanel } from "./CandidatePanel";
import { ImagePromptBuilder } from "./ImagePromptBuilder";
import { useAssetWorkspace } from "./use-asset-workspace";

export function AssetStage(props: Parameters<typeof useAssetWorkspace>[0]) {
  const state = useAssetWorkspace(props);
  return <div className="grid min-h-[calc(100vh-344px)] grid-cols-[minmax(250px,.78fr)_minmax(480px,1.45fr)_minmax(330px,1fr)] max-md:grid-cols-1">
    <AssetLibrary assets={state.assets} count={state.allAssets.length} gaps={state.gaps} selectedId={state.selectedAsset?.id} busy={state.busy} draft={{ name: state.newAssetName, type: state.newAssetType, parentId: state.parentAssetId, stateLabel: state.stateLabel }} onDraft={(next) => { if (next.name !== undefined) state.setNewAssetName(next.name); if (next.type !== undefined) state.setNewAssetType(next.type); if (next.parentId !== undefined) state.setParentAssetId(next.parentId); if (next.stateLabel !== undefined) state.setStateLabel(next.stateLabel); }} onSelect={state.chooseAsset} onCreate={() => void state.createAsset()} />
    <ImagePromptBuilder asset={state.selectedAsset} episode={state.episode} busy={state.busy} alias={state.aliasDraft} prompt={state.prompt} derivedFromCandidateId={state.derivedFromCandidateId} parts={state.promptParts} draftKind={state.draftKind} onDraftKind={state.setDraftKind} onDraft={() => void state.generatePromptDraft()} onAlias={state.setAliasDraft} onAddAlias={() => void state.addAlias()} onPart={state.updatePromptPart} onPrompt={state.updatePrompt} onGenerate={() => void state.generateCandidate()} />
    <CandidatePanel candidates={state.candidates} histories={state.reviewHistory} assetName={state.selectedAsset?.name} busy={state.busy} onUpload={(file) => void state.uploadCandidate(file)} onRestore={state.restoreCandidatePrompt} onLoadHistory={state.loadReviewHistory} onReview={state.reviewCandidate} />
  </div>;
}
