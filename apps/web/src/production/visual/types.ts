import type { AssetRecord, CandidateRecord } from "../assets/types";

export type VisualMotionKind = "none" | "pan-left" | "pan-right" | "zoom-in" | "zoom-out";

export interface VisualSegment {
  id: string;
  episodeId: string;
  segmentIndex: number;
  timelineHash: string;
  cueStartIndex: number;
  cueEndIndex: number;
  startMs: number;
  endMs: number;
  motionKind: VisualMotionKind;
  motionAmountPpm: number;
  fadeMs: number;
  revision: number;
  assets: Array<{ assetId: string; selectedCandidateId: string | null; candidateReviewRevision: number | null }>;
  productionReady: boolean;
}

export interface VisualSegmentDraft {
  segmentIndex: number;
  cueStartIndex: number;
  cueEndIndex: number;
  motionKind: VisualMotionKind;
  motionAmountPpm: number;
  fadeMs: number;
  expectedRevision: number;
  assetIds: string[];
  selectedAssetId: string;
  selectedCandidateId: string;
}

export interface VisualAsset extends AssetRecord { candidates: CandidateRecord[] }

export interface ContactSheetResult {
  episodeId: string;
  timelineHash: string;
  directoryPath: string;
  jsonPath: string;
  htmlPath: string;
  jsonHash: string;
  htmlHash: string;
}
