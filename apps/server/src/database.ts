import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDataRoot } from "./config.js";

const MIGRATION_1 = `
  CREATE TABLE books (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author TEXT,
    original_file_path TEXT NOT NULL,
    original_file_hash TEXT NOT NULL UNIQUE,
    encoding TEXT NOT NULL,
    import_status TEXT NOT NULL CHECK (import_status IN ('importing', 'ready', 'failed')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) STRICT;

  CREATE TABLE chapters (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_index INTEGER NOT NULL CHECK (chapter_index >= 0),
    chapter_number TEXT,
    title TEXT NOT NULL,
    byte_start INTEGER NOT NULL CHECK (byte_start >= 0),
    byte_end INTEGER NOT NULL CHECK (byte_end >= byte_start),
    char_count INTEGER NOT NULL CHECK (char_count >= 0),
    content_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (book_id, chapter_index)
  ) STRICT;

  CREATE INDEX chapters_book_order ON chapters(book_id, chapter_index);
`;

const MIGRATION_2 = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    priority INTEGER NOT NULL DEFAULT 0,
    progress REAL NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    run_after INTEGER NOT NULL,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    result_json TEXT,
    error_code TEXT,
    error_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER,
    finished_at INTEGER,
    CHECK (
      (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
      OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL)
    )
  ) STRICT;

  CREATE INDEX jobs_ready_queue ON jobs(status, run_after, priority DESC, created_at);
  CREATE INDEX jobs_expired_lease ON jobs(status, lease_expires_at);
`;

const MIGRATION_3 = `
  CREATE TABLE job_checkpoints (
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (length(stage) > 0),
    scope_key TEXT NOT NULL CHECK (length(scope_key) > 0),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
    PRIMARY KEY (job_id, stage, scope_key)
  ) STRICT;
`;

const MIGRATION_4 = `
  CREATE TABLE chapter_events (
    id TEXT PRIMARY KEY,
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    event_index INTEGER NOT NULL CHECK (event_index >= 0),
    occurrence INTEGER NOT NULL CHECK (occurrence >= 0),
    event_type TEXT NOT NULL CHECK (
      event_type IN ('character', 'location', 'prop', 'causality', 'revelation', 'suspense')
    ),
    payload_json TEXT NOT NULL CHECK (length(payload_json) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (chapter_id, event_index)
  ) STRICT;

  CREATE TABLE chapter_event_sources (
    event_id TEXT NOT NULL REFERENCES chapter_events(id) ON DELETE CASCADE,
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (event_id, source_index),
    UNIQUE (event_id, source_byte_start, source_byte_end)
  ) STRICT;

  CREATE INDEX chapter_events_chapter_order
    ON chapter_events(chapter_id, event_index);
`;

const MIGRATION_5 = `
  CREATE TABLE series_projects (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;

  CREATE INDEX series_projects_book_order
    ON series_projects(book_id, created_at, id);

  CREATE TABLE episodes (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    episode_index INTEGER NOT NULL CHECK (episode_index >= 1),
    title TEXT NOT NULL CHECK (length(title) > 0),
    story_arc TEXT NOT NULL CHECK (length(story_arc) > 0),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 180 AND 300),
    recap TEXT,
    next_hook TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE (series_project_id, episode_index)
  ) STRICT;

  CREATE TABLE episode_sources (
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    source_event_id TEXT NOT NULL,
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (episode_id, source_index)
  ) STRICT;
`;

const MIGRATION_6 = `
  CREATE TABLE script_versions (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('faithful', 'packaged')),
    version INTEGER NOT NULL CHECK (version >= 1),
    parent_version_id TEXT REFERENCES script_versions(id),
    content_json TEXT NOT NULL CHECK (length(content_json) > 0),
    content_hash TEXT NOT NULL CHECK (
      length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, kind, version)
  ) STRICT;

  CREATE TABLE script_version_sources (
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    episode_source_index INTEGER NOT NULL CHECK (episode_source_index >= 0),
    chapter_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    source_byte_start INTEGER NOT NULL CHECK (source_byte_start >= 0),
    source_byte_end INTEGER NOT NULL CHECK (source_byte_end > source_byte_start),
    source_hash TEXT NOT NULL CHECK (
      length(source_hash) = 64 AND source_hash NOT GLOB '*[^0-9a-f]*'
    ),
    PRIMARY KEY (script_version_id, segment_index, source_index)
  ) STRICT;

  CREATE INDEX script_versions_episode_order
    ON script_versions(episode_id, kind, version);
`;

const MIGRATION_7 = `
  CREATE TABLE script_approval_events (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('approve', 'withdraw')),
    script_version_id TEXT NOT NULL REFERENCES script_versions(id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, revision)
  ) STRICT;

  CREATE INDEX script_approval_events_episode_revision
    ON script_approval_events(episode_id, revision DESC);
`;

const MIGRATION_8 = `
  CREATE TABLE audio_segments (
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    text TEXT NOT NULL CHECK (length(text) > 0),
    provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
    voice TEXT NOT NULL CHECK (length(voice) > 0),
    rate INTEGER NOT NULL CHECK (rate BETWEEN -10 AND 10),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    file_hash TEXT NOT NULL CHECK (
      length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'
    ),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (timeline_hash, segment_index),
    UNIQUE (timeline_hash, segment_index, episode_id, script_version_id)
  ) STRICT;

  CREATE INDEX audio_segments_episode_script_order
    ON audio_segments(episode_id, script_version_id, timeline_hash, segment_index);

  CREATE TABLE subtitle_cues (
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    cue_index INTEGER NOT NULL CHECK (cue_index >= 0),
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    script_version_id TEXT NOT NULL REFERENCES script_versions(id) ON DELETE CASCADE,
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    text TEXT NOT NULL CHECK (length(text) > 0),
    PRIMARY KEY (timeline_hash, cue_index),
    FOREIGN KEY (timeline_hash, segment_index, episode_id, script_version_id)
      REFERENCES audio_segments(timeline_hash, segment_index, episode_id, script_version_id)
      ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX subtitle_cues_episode_script_order
    ON subtitle_cues(episode_id, script_version_id, timeline_hash, cue_index);
`;

const MIGRATION_9 = `
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('character', 'scene', 'prop')),
    asset_role TEXT NOT NULL CHECK (asset_role IN ('master', 'state')),
    canonical_name TEXT NOT NULL CHECK (length(canonical_name) > 0),
    normalized_name TEXT NOT NULL CHECK (length(normalized_name) > 0),
    parent_asset_id TEXT,
    state_label TEXT,
    description TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (series_project_id, id),
    UNIQUE (series_project_id, asset_type, id),
    CHECK (
      (asset_role = 'master' AND parent_asset_id IS NULL AND state_label IS NULL)
      OR
      (asset_role = 'state' AND parent_asset_id IS NOT NULL AND length(state_label) > 0)
    ),
    CHECK (parent_asset_id IS NULL OR parent_asset_id <> id),
    FOREIGN KEY (series_project_id, asset_type, parent_asset_id)
      REFERENCES assets(series_project_id, asset_type, id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;

  CREATE INDEX assets_series_type_role
    ON assets(series_project_id, asset_type, asset_role, created_at, id);

  CREATE TRIGGER assets_state_parent_is_master
  BEFORE INSERT ON assets
  WHEN NEW.asset_role = 'state'
  BEGIN
    SELECT RAISE(ABORT, 'state asset parent must be master')
    WHERE NOT EXISTS (
      SELECT 1
      FROM assets AS parent
      WHERE parent.id = NEW.parent_asset_id
        AND parent.series_project_id = NEW.series_project_id
        AND parent.asset_type = NEW.asset_type
        AND parent.asset_role = 'master'
    );
  END;

  CREATE TRIGGER assets_state_parent_is_master_on_update
  BEFORE UPDATE ON assets
  WHEN NEW.asset_role = 'state'
  BEGIN
    SELECT RAISE(ABORT, 'state asset parent must be master')
    WHERE NOT EXISTS (
      SELECT 1
      FROM assets AS parent
      WHERE parent.id = NEW.parent_asset_id
        AND parent.series_project_id = NEW.series_project_id
        AND parent.asset_type = NEW.asset_type
        AND parent.asset_role = 'master'
    );
  END;

  CREATE TRIGGER assets_master_with_states_keeps_identity
  BEFORE UPDATE ON assets
  WHEN OLD.asset_role = 'master'
    AND (
      NEW.asset_role <> 'master'
      OR NEW.id <> OLD.id
      OR NEW.series_project_id <> OLD.series_project_id
      OR NEW.asset_type <> OLD.asset_type
    )
    AND EXISTS (
      SELECT 1
      FROM assets AS child
      WHERE child.parent_asset_id = OLD.id
        AND child.series_project_id = OLD.series_project_id
        AND child.asset_type = OLD.asset_type
        AND child.asset_role = 'state'
    )
  BEGIN
    SELECT RAISE(ABORT, 'master asset with state children cannot change hierarchy');
  END;

  CREATE TABLE asset_aliases (
    series_project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    alias TEXT NOT NULL CHECK (length(alias) > 0),
    normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) > 0),
    is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (series_project_id, normalized_alias),
    FOREIGN KEY (series_project_id, asset_id)
      REFERENCES assets(series_project_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX asset_aliases_asset_order
    ON asset_aliases(series_project_id, asset_id, is_primary DESC, normalized_alias);

  CREATE UNIQUE INDEX asset_aliases_one_primary_per_asset
    ON asset_aliases(series_project_id, asset_id)
    WHERE is_primary = 1;
`;

const MIGRATION_10 = `
  CREATE TABLE asset_candidates (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK (source_kind IN ('upload', 'generation')),
    source_identity_hash TEXT NOT NULL CHECK (
      length(source_identity_hash) = 64 AND source_identity_hash NOT GLOB '*[^0-9a-f]*'
    ),
    source_json TEXT NOT NULL CHECK (length(source_json) > 0 AND json_valid(source_json)),
    file_hash TEXT NOT NULL CHECK (
      length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'
    ),
    mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp')),
    width INTEGER NOT NULL CHECK (width BETWEEN 16 AND 8192),
    height INTEGER NOT NULL CHECK (height BETWEEN 16 AND 8192),
    bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 31457280),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (asset_id, source_identity_hash, file_hash)
  ) STRICT;

  CREATE INDEX asset_candidates_asset_order
    ON asset_candidates(asset_id, created_at, id);

  CREATE TABLE asset_candidate_review_events (
    candidate_id TEXT NOT NULL REFERENCES asset_candidates(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'note')),
    note TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (candidate_id, revision),
    CHECK (
      (action = 'note' AND note IS NOT NULL AND length(note) > 0)
      OR (action <> 'note' AND (note IS NULL OR length(note) > 0))
    )
  ) STRICT;
`;

const MIGRATION_11 = `
  CREATE TABLE visual_segments (
    id TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    script_version_id TEXT NOT NULL REFERENCES script_versions(id),
    approval_revision INTEGER NOT NULL CHECK (approval_revision >= 1),
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    cue_start_index INTEGER NOT NULL CHECK (cue_start_index >= 0),
    cue_end_index INTEGER NOT NULL CHECK (cue_end_index >= cue_start_index),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    motion_kind TEXT NOT NULL CHECK (
      motion_kind IN ('none', 'pan-left', 'pan-right', 'zoom-in', 'zoom-out')
    ),
    motion_amount_ppm INTEGER NOT NULL CHECK (motion_amount_ppm BETWEEN 0 AND 1000000),
    fade_ms INTEGER NOT NULL CHECK (fade_ms BETWEEN 0 AND 10000),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (episode_id, timeline_hash, segment_index),
    CHECK (motion_kind <> 'none' OR motion_amount_ppm = 0),
    CHECK (fade_ms * 2 <= end_ms - start_ms)
  ) STRICT;

  CREATE INDEX visual_segments_timeline_order
    ON visual_segments(episode_id, timeline_hash, segment_index);

  CREATE UNIQUE INDEX asset_candidates_id_asset
    ON asset_candidates(id, asset_id);

  CREATE TABLE visual_segment_assets (
    visual_segment_id TEXT NOT NULL REFERENCES visual_segments(id) ON DELETE CASCADE,
    asset_index INTEGER NOT NULL CHECK (asset_index >= 0),
    asset_id TEXT NOT NULL REFERENCES assets(id),
    selected_candidate_id TEXT,
    candidate_review_revision INTEGER,
    PRIMARY KEY (visual_segment_id, asset_index),
    UNIQUE (visual_segment_id, asset_id),
    CHECK (
      (selected_candidate_id IS NULL AND candidate_review_revision IS NULL)
      OR (selected_candidate_id IS NOT NULL AND candidate_review_revision >= 1)
    ),
    FOREIGN KEY (selected_candidate_id, asset_id)
      REFERENCES asset_candidates(id, asset_id)
  ) STRICT;

  CREATE TRIGGER visual_segment_assets_same_series
  BEFORE INSERT ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1
      FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id
        AND asset.series_project_id = episode.series_project_id
    );
  END;

  CREATE TRIGGER visual_segment_assets_same_series_on_update
  BEFORE UPDATE ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1
      FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id
        AND asset.series_project_id = episode.series_project_id
    );
  END;
`;

const MIGRATION_12 = `
  CREATE TABLE render_chunks (
    render_hash TEXT PRIMARY KEY CHECK (
      length(render_hash) = 64 AND render_hash NOT GLOB '*[^0-9a-f]*'
    ),
    episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
    timeline_hash TEXT NOT NULL CHECK (
      length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'
    ),
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    script_version_id TEXT NOT NULL REFERENCES script_versions(id),
    approval_revision INTEGER NOT NULL CHECK (approval_revision >= 1),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    file_hash TEXT NOT NULL CHECK (
      length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'
    ),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (episode_id, timeline_hash, chunk_index),
    CHECK (end_ms - start_ms BETWEEN 60000 AND 180000)
  ) STRICT;

  CREATE INDEX render_chunks_episode_order
    ON render_chunks(episode_id, timeline_hash, chunk_index);
`;

const MIGRATION_13 = `
  DROP TRIGGER visual_segment_assets_same_series;
  DROP TRIGGER visual_segment_assets_same_series_on_update;

  CREATE TABLE episodes_v13 (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    episode_index INTEGER NOT NULL CHECK (episode_index >= 1),
    title TEXT NOT NULL CHECK (length(title) > 0),
    story_arc TEXT NOT NULL CHECK (length(story_arc) > 0),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 60 AND 3600),
    recap TEXT,
    next_hook TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    UNIQUE (series_project_id, episode_index)
  ) STRICT;

  INSERT INTO episodes_v13 SELECT * FROM episodes;
  DROP TABLE episodes;
  ALTER TABLE episodes_v13 RENAME TO episodes;

  CREATE TRIGGER visual_segment_assets_same_series
  BEFORE INSERT ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1 FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id AND asset.series_project_id = episode.series_project_id
    );
  END;

  CREATE TRIGGER visual_segment_assets_same_series_on_update
  BEFORE UPDATE ON visual_segment_assets
  BEGIN
    SELECT RAISE(ABORT, 'visual segment asset must belong to episode series')
    WHERE NOT EXISTS (
      SELECT 1 FROM visual_segments segment
      JOIN episodes episode ON episode.id = segment.episode_id
      JOIN assets asset ON asset.id = NEW.asset_id
      WHERE segment.id = NEW.visual_segment_id AND asset.series_project_id = episode.series_project_id
    );
  END;
`;

const MIGRATION_14 = `
  CREATE TABLE series_pipeline_runs (
    id TEXT PRIMARY KEY,
    series_project_id TEXT NOT NULL REFERENCES series_projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN (
      'configured', 'analyzing_chapters', 'building_story_bible', 'planning_episodes',
      'validating_plan', 'freezing_plan', 'generating_scripts', 'checking_coverage',
      'awaiting_review', 'paused', 'failed', 'cancelled', 'completed'
    )),
    resume_status TEXT CHECK (resume_status IS NULL OR resume_status IN (
      'configured', 'analyzing_chapters', 'building_story_bible', 'planning_episodes',
      'validating_plan', 'freezing_plan', 'generating_scripts', 'checking_coverage',
      'awaiting_review', 'failed'
    )),
    episode_count INTEGER NOT NULL CHECK (episode_count BETWEEN 1 AND 1000),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 60 AND 3600),
    source_start_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    source_end_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    config_hash TEXT NOT NULL CHECK (
      length(config_hash) = 64 AND config_hash NOT GLOB '*[^0-9a-f]*'
    ),
    chapter_events_hash TEXT CHECK (
      chapter_events_hash IS NULL OR (
        length(chapter_events_hash) = 64 AND chapter_events_hash NOT GLOB '*[^0-9a-f]*'
      )
    ),
    story_bible_id TEXT,
    plan_hash TEXT CHECK (
      plan_hash IS NULL OR (length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*')
    ),
    failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 128),
    failure_message TEXT CHECK (failure_message IS NULL OR length(failure_message) BETWEEN 1 AND 2000),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    CHECK ((status = 'paused') = (resume_status IS NOT NULL))
  ) STRICT;

  CREATE UNIQUE INDEX series_pipeline_runs_one_current
    ON series_pipeline_runs(series_project_id)
    WHERE status NOT IN ('cancelled', 'completed');

  CREATE INDEX series_pipeline_runs_status
    ON series_pipeline_runs(status, updated_at, id);

  CREATE TABLE series_pipeline_jobs (
    run_id TEXT NOT NULL REFERENCES series_pipeline_runs(id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('chapter_analysis', 'story_bible', 'episode_plan', 'script_generation')),
    subject_type TEXT NOT NULL CHECK (subject_type IN ('chapter', 'bible_chunk', 'plan', 'episode')),
    subject_id TEXT NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 200),
    job_id TEXT NOT NULL REFERENCES jobs(id),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (run_id, stage, subject_type, subject_id)
  ) STRICT;

  CREATE INDEX series_pipeline_jobs_job
    ON series_pipeline_jobs(job_id);
`;

const MIGRATION_15 = `
  CREATE TABLE book_story_bibles (
    id TEXT PRIMARY KEY,
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('interval', 'final')),
    source_start_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    source_end_chapter_id TEXT NOT NULL REFERENCES chapters(id),
    source_event_ids_json TEXT NOT NULL CHECK (
      length(source_event_ids_json) BETWEEN 3 AND 1048576
    ),
    source_events_hash TEXT NOT NULL CHECK (
      length(source_events_hash) = 64 AND source_events_hash NOT GLOB '*[^0-9a-f]*'
    ),
    parent_bible_ids_json TEXT NOT NULL CHECK (
      length(parent_bible_ids_json) BETWEEN 2 AND 1048576
    ),
    input_hash TEXT NOT NULL CHECK (
      length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'
    ),
    contract_version TEXT NOT NULL CHECK (length(contract_version) BETWEEN 1 AND 100),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 200),
    model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 200),
    job_id TEXT REFERENCES jobs(id),
    content_json TEXT NOT NULL CHECK (length(content_json) BETWEEN 2 AND 8388608),
    content_hash TEXT NOT NULL CHECK (
      length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    invalidated_at INTEGER CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
    UNIQUE (
      book_id, scope, source_start_chapter_id, source_end_chapter_id,
      source_events_hash, input_hash, contract_version, revision
    )
  ) STRICT;

  CREATE INDEX book_story_bibles_reuse
    ON book_story_bibles (
      book_id, scope, source_start_chapter_id, source_end_chapter_id,
      source_events_hash, input_hash, contract_version, invalidated_at, revision DESC
    );

  CREATE TRIGGER book_story_bibles_range_guard
  BEFORE INSERT ON book_story_bibles
  BEGIN
    SELECT RAISE(ABORT, 'book story bible range must belong to book and be ordered')
    WHERE NOT EXISTS (
      SELECT 1 FROM chapters start
      JOIN chapters finish ON finish.book_id = start.book_id
      WHERE start.id = NEW.source_start_chapter_id
        AND finish.id = NEW.source_end_chapter_id
        AND start.book_id = NEW.book_id
        AND start.chapter_index <= finish.chapter_index
    );
  END;

  CREATE TRIGGER book_story_bibles_immutable
  BEFORE UPDATE ON book_story_bibles
  WHEN NEW.id IS NOT OLD.id
    OR NEW.book_id IS NOT OLD.book_id
    OR NEW.scope IS NOT OLD.scope
    OR NEW.source_start_chapter_id IS NOT OLD.source_start_chapter_id
    OR NEW.source_end_chapter_id IS NOT OLD.source_end_chapter_id
    OR NEW.source_event_ids_json IS NOT OLD.source_event_ids_json
    OR NEW.source_events_hash IS NOT OLD.source_events_hash
    OR NEW.parent_bible_ids_json IS NOT OLD.parent_bible_ids_json
    OR NEW.input_hash IS NOT OLD.input_hash
    OR NEW.contract_version IS NOT OLD.contract_version
    OR NEW.revision IS NOT OLD.revision
    OR NEW.provider_id IS NOT OLD.provider_id
    OR NEW.model IS NOT OLD.model
    OR NEW.job_id IS NOT OLD.job_id
    OR NEW.content_json IS NOT OLD.content_json
    OR NEW.content_hash IS NOT OLD.content_hash
    OR NEW.created_at IS NOT OLD.created_at
    OR OLD.invalidated_at IS NOT NULL
    OR NEW.invalidated_at IS NULL
  BEGIN
    SELECT RAISE(ABORT, 'book story bible versions are immutable');
  END;
`;

const MIGRATION_16 = `
  ALTER TABLE series_pipeline_runs
    ADD COLUMN chapter_batch_size INTEGER NOT NULL DEFAULT 1
      CHECK (chapter_batch_size BETWEEN 1 AND 20);
  ALTER TABLE series_pipeline_runs
    ADD COLUMN chapter_concurrency INTEGER NOT NULL DEFAULT 1
      CHECK (chapter_concurrency BETWEEN 1 AND 8);
`;

const MIGRATION_17 = `
  ALTER TABLE job_checkpoints
    ADD COLUMN output_json TEXT
      CHECK (
        output_json IS NULL OR (
          json_valid(output_json)
          AND length(CAST(output_json AS BLOB)) <= 1048576
        )
      );
`;

const MIGRATION_18 = `
  ALTER TABLE script_versions ADD COLUMN script_contract_version INTEGER NOT NULL DEFAULT 5
    CHECK (script_contract_version IN (5, 6));
  ALTER TABLE series_pipeline_runs ADD COLUMN planning_contract_version INTEGER NOT NULL DEFAULT 1
    CHECK (planning_contract_version IN (1, 2));
  ALTER TABLE series_pipeline_runs ADD COLUMN episode_ranges_json TEXT
    CHECK (episode_ranges_json IS NULL OR json_valid(episode_ranges_json));
  ALTER TABLE series_pipeline_runs ADD COLUMN script_contract_version INTEGER NOT NULL DEFAULT 5
    CHECK (script_contract_version IN (5, 6));
  ALTER TABLE series_pipeline_runs ADD COLUMN product_prompt_version TEXT
    CHECK (product_prompt_version IS NULL OR length(product_prompt_version) BETWEEN 1 AND 100);
  ALTER TABLE series_pipeline_runs ADD COLUMN book_prompt_profile_revision INTEGER
    CHECK (book_prompt_profile_revision IS NULL OR book_prompt_profile_revision >= 1);
  ALTER TABLE series_pipeline_runs ADD COLUMN book_prompt_profile_hash TEXT
    CHECK (book_prompt_profile_hash IS NULL OR (
      length(book_prompt_profile_hash) = 64 AND book_prompt_profile_hash NOT GLOB '*[^0-9a-f]*'
    ));

  CREATE TABLE book_prompt_profiles (
    book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    shared_instructions TEXT NOT NULL,
    chapter_analysis_instructions TEXT NOT NULL,
    story_bible_instructions TEXT NOT NULL,
    episode_planning_instructions TEXT NOT NULL,
    narration_instructions TEXT NOT NULL,
    asset_instructions TEXT NOT NULL,
    profile_hash TEXT NOT NULL CHECK (
      length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (book_id, revision)
  ) STRICT;

  CREATE TRIGGER book_prompt_profiles_immutable BEFORE UPDATE ON book_prompt_profiles
  BEGIN SELECT RAISE(ABORT, 'book prompt profile revisions are immutable'); END;
`;

const MIGRATION_19 = `
  ALTER TABLE series_pipeline_runs ADD COLUMN chapter_concurrency_v19 INTEGER;
  UPDATE series_pipeline_runs SET chapter_concurrency_v19 = chapter_concurrency;
  ALTER TABLE series_pipeline_runs DROP COLUMN chapter_concurrency;
  ALTER TABLE series_pipeline_runs ADD COLUMN chapter_concurrency INTEGER NOT NULL DEFAULT 1
    CHECK (chapter_concurrency BETWEEN 1 AND 50);
  UPDATE series_pipeline_runs SET chapter_concurrency = chapter_concurrency_v19;
  ALTER TABLE series_pipeline_runs DROP COLUMN chapter_concurrency_v19;
`;

const MIGRATION_20 = `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE TABLE videos (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
    status TEXT NOT NULL CHECK (status = 'draft'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at)
  ) STRICT;

  CREATE INDEX videos_project_order
    ON videos(project_id, updated_at DESC, id);
`;

const MIGRATION_21 = `
  ALTER TABLE projects ADD COLUMN script_instructions TEXT NOT NULL DEFAULT ''
    CHECK (length(script_instructions) <= 20000);
  ALTER TABLE projects ADD COLUMN visual_instructions TEXT NOT NULL DEFAULT ''
    CHECK (length(visual_instructions) <= 20000);

  ALTER TABLE videos ADD COLUMN input_mode TEXT NOT NULL DEFAULT 'topic'
    CHECK (input_mode IN ('topic', 'body'));
  ALTER TABLE videos ADD COLUMN topic TEXT NOT NULL DEFAULT ''
    CHECK (length(topic) <= 200);
  ALTER TABLE videos ADD COLUMN body TEXT NOT NULL DEFAULT ''
    CHECK (length(CAST(body AS BLOB)) <= 131072);
  ALTER TABLE videos ADD COLUMN reference_text TEXT NOT NULL DEFAULT ''
    CHECK (length(CAST(reference_text AS BLOB)) <= 65536);
  ALTER TABLE videos ADD COLUMN reference_role TEXT NOT NULL DEFAULT 'style_only'
    CHECK (reference_role IN ('style_only', 'content_source'));
  ALTER TABLE videos ADD COLUMN target_duration_seconds INTEGER NOT NULL DEFAULT 180
    CHECK (target_duration_seconds BETWEEN 60 AND 600);
  ALTER TABLE videos ADD COLUMN visual_density TEXT NOT NULL DEFAULT 'standard'
    CHECK (visual_density IN ('relaxed', 'standard', 'compact'));
  ALTER TABLE videos ADD COLUMN web_enabled INTEGER NOT NULL DEFAULT 1
    CHECK (web_enabled IN (0, 1));
  ALTER TABLE videos ADD COLUMN script_instructions TEXT NOT NULL DEFAULT ''
    CHECK (length(script_instructions) <= 20000);
  ALTER TABLE videos ADD COLUMN visual_instructions TEXT NOT NULL DEFAULT ''
    CHECK (length(visual_instructions) <= 20000);

  CREATE TABLE global_prompt_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    script_instructions TEXT NOT NULL CHECK (length(script_instructions) <= 20000),
    visual_instructions TEXT NOT NULL CHECK (length(visual_instructions) <= 20000),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;
  INSERT INTO global_prompt_settings (id, script_instructions, visual_instructions, updated_at)
    VALUES (1, '', '', 0);
`;

const MIGRATION_22 = `
  CREATE TABLE videos_v22 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
    status TEXT NOT NULL CHECK (status IN (
      'draft', 'preparing_sources', 'generating_script', 'planning_visuals',
      'awaiting_review', 'failed', 'cancelled'
    )),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    input_mode TEXT NOT NULL DEFAULT 'topic' CHECK (input_mode IN ('topic', 'body')),
    topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 200),
    body TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body AS BLOB)) <= 131072),
    reference_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(reference_text AS BLOB)) <= 65536),
    reference_role TEXT NOT NULL DEFAULT 'style_only' CHECK (reference_role IN ('style_only', 'content_source')),
    target_duration_seconds INTEGER NOT NULL DEFAULT 180 CHECK (target_duration_seconds BETWEEN 60 AND 600),
    visual_density TEXT NOT NULL DEFAULT 'standard' CHECK (visual_density IN ('relaxed', 'standard', 'compact')),
    web_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_enabled IN (0, 1)),
    script_instructions TEXT NOT NULL DEFAULT '' CHECK (length(script_instructions) <= 20000),
    visual_instructions TEXT NOT NULL DEFAULT '' CHECK (length(visual_instructions) <= 20000)
  ) STRICT;

  INSERT INTO videos_v22 (
    id, project_id, title, status, created_at, updated_at, input_mode, topic, body,
    reference_text, reference_role, target_duration_seconds, visual_density, web_enabled,
    script_instructions, visual_instructions
  ) SELECT
    id, project_id, title, status, created_at, updated_at, input_mode, topic, body,
    reference_text, reference_role, target_duration_seconds, visual_density, web_enabled,
    script_instructions, visual_instructions
  FROM videos;
  DROP TABLE videos;
  ALTER TABLE videos_v22 RENAME TO videos;
  CREATE INDEX videos_project_order ON videos(project_id, updated_at DESC, id);

  CREATE TABLE video_plan_snapshots (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    input_json TEXT NOT NULL CHECK (length(input_json) > 0 AND json_valid(input_json)),
    prompt_json TEXT NOT NULL CHECK (length(prompt_json) > 0 AND json_valid(prompt_json)),
    model_json TEXT NOT NULL CHECK (length(model_json) > 0 AND json_valid(model_json)),
    system_contract_version TEXT NOT NULL CHECK (length(system_contract_version) > 0),
    web_capability TEXT NOT NULL CHECK (length(web_capability) > 0),
    canonical_json TEXT NOT NULL CHECK (length(canonical_json) > 0 AND json_valid(canonical_json)),
    snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    invalidated_at INTEGER CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
    UNIQUE (video_id, idempotency_key),
    UNIQUE (id, video_id)
  ) STRICT;

  CREATE TABLE video_plan_jobs (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    FOREIGN KEY (snapshot_id, video_id) REFERENCES video_plan_snapshots(id, video_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_plan_sources (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    source_index INTEGER NOT NULL CHECK (source_index >= 0),
    query TEXT NOT NULL CHECK (length(query) > 0),
    provider TEXT NOT NULL CHECK (length(provider) > 0),
    tool TEXT NOT NULL CHECK (length(tool) > 0),
    retrieved_at INTEGER NOT NULL CHECK (retrieved_at >= 0),
    url TEXT NOT NULL CHECK (length(url) > 0),
    title TEXT NOT NULL CHECK (length(title) > 0),
    usage_summary TEXT NOT NULL,
    audit_excerpt TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
    failure_summary TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (snapshot_id, source_index),
    FOREIGN KEY (snapshot_id, video_id) REFERENCES video_plan_snapshots(id, video_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_script_revisions (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    content_json TEXT NOT NULL CHECK (length(content_json) > 0 AND json_valid(content_json)),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
    model_id TEXT NOT NULL CHECK (length(model_id) > 0),
    prompt_version TEXT NOT NULL CHECK (length(prompt_version) > 0),
    prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, revision),
    UNIQUE (id, video_id, snapshot_id, content_hash),
    FOREIGN KEY (snapshot_id, video_id) REFERENCES video_plan_snapshots(id, video_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_visual_revisions (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    script_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    content_json TEXT NOT NULL CHECK (length(content_json) > 0 AND json_valid(content_json)),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, revision),
    UNIQUE (id, video_id, snapshot_id, content_hash),
    FOREIGN KEY (snapshot_id, video_id) REFERENCES video_plan_snapshots(id, video_id) ON DELETE CASCADE,
    FOREIGN KEY (script_revision_id, video_id, snapshot_id, script_content_hash)
      REFERENCES video_script_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_plan_approvals (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    script_revision_id TEXT NOT NULL,
    visual_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    visual_content_hash TEXT NOT NULL CHECK (length(visual_content_hash) = 64 AND visual_content_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, revision),
    FOREIGN KEY (snapshot_id, video_id) REFERENCES video_plan_snapshots(id, video_id) ON DELETE CASCADE,
    FOREIGN KEY (script_revision_id, video_id, snapshot_id, script_content_hash)
      REFERENCES video_script_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE,
    FOREIGN KEY (visual_revision_id, video_id, snapshot_id, visual_content_hash)
      REFERENCES video_visual_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE
  ) STRICT;

  -- 冻结快照只允许首次写入失效时间；生成与审核必须始终引用原始身份。
  CREATE TRIGGER video_plan_snapshots_immutable BEFORE UPDATE ON video_plan_snapshots
  WHEN OLD.id IS NOT NEW.id OR OLD.video_id IS NOT NEW.video_id OR OLD.idempotency_key IS NOT NEW.idempotency_key
    OR OLD.input_json IS NOT NEW.input_json OR OLD.prompt_json IS NOT NEW.prompt_json OR OLD.model_json IS NOT NEW.model_json
    OR OLD.system_contract_version IS NOT NEW.system_contract_version OR OLD.web_capability IS NOT NEW.web_capability
    OR OLD.canonical_json IS NOT NEW.canonical_json OR OLD.snapshot_hash IS NOT NEW.snapshot_hash
    OR OLD.created_at IS NOT NEW.created_at OR OLD.invalidated_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'video plan snapshot is immutable'); END;
  CREATE TRIGGER video_plan_snapshots_no_delete BEFORE DELETE ON video_plan_snapshots
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video plan snapshot is immutable'); END;

  CREATE TRIGGER video_script_revisions_immutable BEFORE UPDATE ON video_script_revisions
  BEGIN SELECT RAISE(ABORT, 'video script revisions are append-only'); END;
  CREATE TRIGGER video_script_revisions_no_delete BEFORE DELETE ON video_script_revisions
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video script revisions are append-only'); END;
  CREATE TRIGGER video_visual_revisions_immutable BEFORE UPDATE ON video_visual_revisions
  BEGIN SELECT RAISE(ABORT, 'video visual revisions are append-only'); END;
  CREATE TRIGGER video_visual_revisions_no_delete BEFORE DELETE ON video_visual_revisions
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video visual revisions are append-only'); END;
  CREATE TRIGGER video_plan_approvals_immutable BEFORE UPDATE ON video_plan_approvals
  BEGIN SELECT RAISE(ABORT, 'video plan approvals are append-only'); END;
  CREATE TRIGGER video_plan_approvals_no_delete BEFORE DELETE ON video_plan_approvals
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video plan approvals are append-only'); END;
`;

const MIGRATION_23 = `
  DROP TRIGGER video_plan_snapshots_immutable;
  DROP TRIGGER video_plan_snapshots_no_delete;
  DROP TRIGGER video_script_revisions_immutable;
  DROP TRIGGER video_script_revisions_no_delete;
  DROP TRIGGER video_visual_revisions_immutable;
  DROP TRIGGER video_visual_revisions_no_delete;
  DROP TRIGGER video_plan_approvals_immutable;
  DROP TRIGGER video_plan_approvals_no_delete;

  CREATE TABLE videos_v23 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
    status TEXT NOT NULL CHECK (status IN (
      'draft', 'preparing_sources', 'generating_script', 'planning_visuals',
      'awaiting_review', 'producing_media', 'awaiting_media_review', 'failed', 'cancelled'
    )),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    input_mode TEXT NOT NULL DEFAULT 'topic' CHECK (input_mode IN ('topic', 'body')),
    topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 200),
    body TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body AS BLOB)) <= 131072),
    reference_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(reference_text AS BLOB)) <= 65536),
    reference_role TEXT NOT NULL DEFAULT 'style_only' CHECK (reference_role IN ('style_only', 'content_source')),
    target_duration_seconds INTEGER NOT NULL DEFAULT 180 CHECK (target_duration_seconds BETWEEN 60 AND 600),
    visual_density TEXT NOT NULL DEFAULT 'standard' CHECK (visual_density IN ('relaxed', 'standard', 'compact')),
    web_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_enabled IN (0, 1)),
    script_instructions TEXT NOT NULL DEFAULT '' CHECK (length(script_instructions) <= 20000),
    visual_instructions TEXT NOT NULL DEFAULT '' CHECK (length(visual_instructions) <= 20000),
    UNIQUE (id, project_id)
  ) STRICT;
  INSERT INTO videos_v23 SELECT * FROM videos;
  DROP TABLE videos;
  ALTER TABLE videos_v23 RENAME TO videos;
  CREATE INDEX videos_project_order ON videos(project_id, updated_at DESC, id);

  CREATE TRIGGER video_plan_snapshots_immutable BEFORE UPDATE ON video_plan_snapshots
  WHEN OLD.id IS NOT NEW.id OR OLD.video_id IS NOT NEW.video_id OR OLD.idempotency_key IS NOT NEW.idempotency_key
    OR OLD.input_json IS NOT NEW.input_json OR OLD.prompt_json IS NOT NEW.prompt_json OR OLD.model_json IS NOT NEW.model_json
    OR OLD.system_contract_version IS NOT NEW.system_contract_version OR OLD.web_capability IS NOT NEW.web_capability
    OR OLD.canonical_json IS NOT NEW.canonical_json OR OLD.snapshot_hash IS NOT NEW.snapshot_hash
    OR OLD.created_at IS NOT NEW.created_at OR OLD.invalidated_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'video plan snapshot is immutable'); END;
  CREATE TRIGGER video_plan_snapshots_no_delete BEFORE DELETE ON video_plan_snapshots
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video plan snapshot is immutable'); END;
  CREATE TRIGGER video_script_revisions_immutable BEFORE UPDATE ON video_script_revisions
  BEGIN SELECT RAISE(ABORT, 'video script revisions are append-only'); END;
  CREATE TRIGGER video_script_revisions_no_delete BEFORE DELETE ON video_script_revisions
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video script revisions are append-only'); END;
  CREATE TRIGGER video_visual_revisions_immutable BEFORE UPDATE ON video_visual_revisions
  BEGIN SELECT RAISE(ABORT, 'video visual revisions are append-only'); END;
  CREATE TRIGGER video_visual_revisions_no_delete BEFORE DELETE ON video_visual_revisions
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video visual revisions are append-only'); END;
  CREATE TRIGGER video_plan_approvals_immutable BEFORE UPDATE ON video_plan_approvals
  BEGIN SELECT RAISE(ABORT, 'video plan approvals are append-only'); END;
  CREATE TRIGGER video_plan_approvals_no_delete BEFORE DELETE ON video_plan_approvals
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video plan approvals are append-only'); END;

  CREATE UNIQUE INDEX video_plan_snapshots_frozen_identity
    ON video_plan_snapshots(id, video_id, snapshot_hash);

  CREATE TABLE video_image_batches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    plan_snapshot_id TEXT NOT NULL,
    plan_snapshot_hash TEXT NOT NULL CHECK (length(plan_snapshot_hash) = 64 AND plan_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    script_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    visual_revision_id TEXT NOT NULL,
    visual_content_hash TEXT NOT NULL CHECK (length(visual_content_hash) = 64 AND visual_content_hash NOT GLOB '*[^0-9a-f]*'),
    mode TEXT NOT NULL CHECK (mode IN ('batch', 'single', 'retry_failed')),
    idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
    provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
    model_id TEXT NOT NULL CHECK (length(model_id) > 0),
    planned_count INTEGER NOT NULL CHECK (planned_count >= 1),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, idempotency_key),
    UNIQUE (id, video_id),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_snapshot_id, video_id, plan_snapshot_hash)
      REFERENCES video_plan_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE,
    FOREIGN KEY (script_revision_id, video_id, plan_snapshot_id, script_content_hash)
      REFERENCES video_script_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE,
    FOREIGN KEY (visual_revision_id, video_id, plan_snapshot_id, visual_content_hash)
      REFERENCES video_visual_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_image_batch_items (
    batch_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    visual_id TEXT NOT NULL CHECK (length(visual_id) > 0),
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    request_identity TEXT NOT NULL UNIQUE CHECK (length(request_identity) > 0),
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    PRIMARY KEY (batch_id, visual_id),
    FOREIGN KEY (batch_id, video_id) REFERENCES video_image_batches(id, video_id) ON DELETE CASCADE
  ) STRICT;
  CREATE UNIQUE INDEX video_image_items_one_active_visual
    ON video_image_batch_items(video_id, visual_id)
    WHERE status IN ('queued', 'running');
  CREATE INDEX video_image_items_batch_status
    ON video_image_batch_items(batch_id, status, visual_id);

  CREATE TABLE video_image_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    plan_snapshot_id TEXT NOT NULL,
    plan_snapshot_hash TEXT NOT NULL CHECK (length(plan_snapshot_hash) = 64 AND plan_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    script_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    visual_revision_id TEXT NOT NULL,
    visual_content_hash TEXT NOT NULL CHECK (length(visual_content_hash) = 64 AND visual_content_hash NOT GLOB '*[^0-9a-f]*'),
    visual_id TEXT NOT NULL CHECK (length(visual_id) > 0),
    prompt TEXT NOT NULL CHECK (length(prompt) > 0),
    negative_prompt TEXT NOT NULL,
    style_snapshot_json TEXT NOT NULL CHECK (json_valid(style_snapshot_json)),
    prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
    provider_id TEXT,
    model_id TEXT,
    params_json TEXT NOT NULL CHECK (json_valid(params_json)),
    request_identity TEXT NOT NULL UNIQUE CHECK (length(request_identity) > 0),
    job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
    attempt INTEGER NOT NULL CHECK (attempt >= 1),
    checkpoint_scope TEXT NOT NULL CHECK (length(checkpoint_scope) > 0),
    provider_request_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
    error_category TEXT,
    error_summary TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('generated', 'upload')),
    original_file_name TEXT,
    relative_path TEXT,
    mime TEXT CHECK (mime IS NULL OR mime IN ('image/png', 'image/jpeg', 'image/webp')),
    bytes INTEGER CHECK (bytes IS NULL OR bytes > 0),
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    file_hash TEXT CHECK (file_hash IS NULL OR (length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*')),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (id, project_id, video_id, visual_id, file_hash),
    CHECK ((origin = 'upload' AND provider_id IS NULL AND model_id IS NULL AND job_id IS NULL)
      OR (origin = 'generated' AND provider_id IS NOT NULL AND model_id IS NOT NULL)),
    CHECK ((status = 'succeeded' AND error_category IS NULL AND error_summary IS NULL
      AND relative_path IS NOT NULL AND mime IS NOT NULL AND bytes IS NOT NULL
      AND width IS NOT NULL AND height IS NOT NULL AND file_hash IS NOT NULL)
      OR (status = 'failed' AND origin = 'generated' AND error_category IS NOT NULL
      AND error_summary IS NOT NULL AND relative_path IS NULL AND mime IS NULL
      AND bytes IS NULL AND width IS NULL AND height IS NULL AND file_hash IS NULL)),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_snapshot_id, video_id, plan_snapshot_hash)
      REFERENCES video_plan_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE,
    FOREIGN KEY (script_revision_id, video_id, plan_snapshot_id, script_content_hash)
      REFERENCES video_script_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE,
    FOREIGN KEY (visual_revision_id, video_id, plan_snapshot_id, visual_content_hash)
      REFERENCES video_visual_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE
  ) STRICT;
  CREATE INDEX video_image_candidates_visual_order
    ON video_image_candidates(video_id, visual_id, created_at, id);

  CREATE TABLE video_image_approval_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    gate_revision INTEGER NOT NULL CHECK (gate_revision >= 1),
    visual_id TEXT NOT NULL CHECK (length(visual_id) > 0),
    candidate_id TEXT NOT NULL,
    plan_snapshot_id TEXT NOT NULL,
    plan_snapshot_hash TEXT NOT NULL CHECK (length(plan_snapshot_hash) = 64 AND plan_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    script_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    visual_revision_id TEXT NOT NULL,
    visual_content_hash TEXT NOT NULL CHECK (length(visual_content_hash) = 64 AND visual_content_hash NOT GLOB '*[^0-9a-f]*'),
    prompt_hash TEXT NOT NULL CHECK (length(prompt_hash) = 64 AND prompt_hash NOT GLOB '*[^0-9a-f]*'),
    candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, gate_revision),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_snapshot_id, video_id, plan_snapshot_hash)
      REFERENCES video_plan_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE,
    FOREIGN KEY (script_revision_id, video_id, plan_snapshot_id, script_content_hash)
      REFERENCES video_script_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE,
    FOREIGN KEY (visual_revision_id, video_id, plan_snapshot_id, visual_content_hash)
      REFERENCES video_visual_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id, project_id, video_id, visual_id, candidate_hash)
      REFERENCES video_image_candidates(id, project_id, video_id, visual_id, file_hash)
  ) STRICT;
  CREATE INDEX video_image_approvals_visual_revision
    ON video_image_approval_events(video_id, visual_id, gate_revision DESC);

  -- 候选与批准都是审计事实；仅允许随所属视频级联清理。
  CREATE TRIGGER video_image_candidates_immutable BEFORE UPDATE ON video_image_candidates
  BEGIN SELECT RAISE(ABORT, 'video image candidates are immutable'); END;
  CREATE TRIGGER video_image_candidates_no_delete BEFORE DELETE ON video_image_candidates
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video image candidates are immutable'); END;
  CREATE TRIGGER video_image_approvals_immutable BEFORE UPDATE ON video_image_approval_events
  BEGIN SELECT RAISE(ABORT, 'video image approval events are append-only'); END;
  CREATE TRIGGER video_image_approvals_no_delete BEFORE DELETE ON video_image_approval_events
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video image approval events are append-only'); END;
`;

const MIGRATION_24 = `
  CREATE TABLE video_tts_snapshots (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    plan_snapshot_id TEXT NOT NULL,
    plan_snapshot_hash TEXT NOT NULL CHECK (length(plan_snapshot_hash) = 64 AND plan_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    script_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    paragraphs_json TEXT NOT NULL CHECK (json_valid(paragraphs_json)),
    provider_id TEXT NOT NULL CHECK (length(provider_id) > 0),
    provider_name TEXT NOT NULL CHECK (length(provider_name) > 0),
    provider_kind TEXT NOT NULL CHECK (length(provider_kind) > 0),
    protocol TEXT NOT NULL CHECK (length(protocol) > 0),
    base_url TEXT NOT NULL,
    model_id TEXT NOT NULL CHECK (length(model_id) > 0),
    voice_id TEXT NOT NULL CHECK (length(voice_id) > 0),
    rate INTEGER NOT NULL CHECK (rate BETWEEN -10 AND 10),
    language TEXT NOT NULL CHECK (length(language) > 0),
    params_json TEXT NOT NULL CHECK (json_valid(params_json)),
    target_duration_seconds INTEGER NOT NULL CHECK (target_duration_seconds BETWEEN 60 AND 600),
    system_contract_version TEXT NOT NULL CHECK (length(system_contract_version) > 0),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    invalidated_at INTEGER CHECK (invalidated_at IS NULL OR invalidated_at >= created_at),
    UNIQUE (video_id, snapshot_hash),
    UNIQUE (id, video_id),
    UNIQUE (id, video_id, snapshot_hash),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_snapshot_id, video_id, plan_snapshot_hash)
      REFERENCES video_plan_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE,
    FOREIGN KEY (script_revision_id, video_id, plan_snapshot_id, script_content_hash)
      REFERENCES video_script_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_tts_jobs (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    snapshot_id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    FOREIGN KEY (snapshot_id, video_id) REFERENCES video_tts_snapshots(id, video_id) ON DELETE CASCADE
  ) STRICT;
  CREATE TABLE video_tts_artifacts (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
    provider_request_id TEXT,
    audio_relative_path TEXT NOT NULL CHECK (length(audio_relative_path) > 0),
    audio_mime TEXT NOT NULL CHECK (audio_mime = 'audio/wav'),
    audio_codec TEXT NOT NULL CHECK (length(audio_codec) > 0),
    sample_rate INTEGER NOT NULL CHECK (sample_rate > 0),
    channels INTEGER NOT NULL CHECK (channels BETWEEN 1 AND 8),
    audio_bytes INTEGER NOT NULL CHECK (audio_bytes > 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    audio_hash TEXT NOT NULL CHECK (length(audio_hash) = 64 AND audio_hash NOT GLOB '*[^0-9a-f]*'),
    cues_hash TEXT NOT NULL CHECK (length(cues_hash) = 64 AND cues_hash NOT GLOB '*[^0-9a-f]*'),
    srt_relative_path TEXT NOT NULL CHECK (length(srt_relative_path) > 0),
    srt_bytes INTEGER NOT NULL CHECK (srt_bytes > 0),
    srt_hash TEXT NOT NULL CHECK (length(srt_hash) = 64 AND srt_hash NOT GLOB '*[^0-9a-f]*'),
    ass_relative_path TEXT NOT NULL CHECK (length(ass_relative_path) > 0),
    ass_bytes INTEGER NOT NULL CHECK (ass_bytes > 0),
    ass_hash TEXT NOT NULL CHECK (length(ass_hash) = 64 AND ass_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (snapshot_id),
    UNIQUE (id, video_id),
    UNIQUE (id, video_id, snapshot_id, audio_hash, cues_hash, srt_hash, ass_hash),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (snapshot_id, video_id, snapshot_hash)
      REFERENCES video_tts_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_tts_cues (
    artifact_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    cue_index INTEGER NOT NULL CHECK (cue_index >= 0),
    paragraph_id TEXT NOT NULL CHECK (length(paragraph_id) > 0),
    text TEXT NOT NULL CHECK (length(text) > 0),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    cue_hash TEXT NOT NULL CHECK (length(cue_hash) = 64 AND cue_hash NOT GLOB '*[^0-9a-f]*'),
    PRIMARY KEY (artifact_id, cue_index),
    FOREIGN KEY (artifact_id, video_id) REFERENCES video_tts_artifacts(id, video_id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_audio_review_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    snapshot_id TEXT NOT NULL,
    snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64 AND snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    artifact_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('approve', 'needs_regeneration')),
    notes TEXT NOT NULL CHECK (length(notes) <= 10000),
    duration_decision TEXT NOT NULL CHECK (duration_decision IN ('within_target', 'accept_actual', 'reprocess')),
    script_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    voice_id TEXT NOT NULL,
    rate INTEGER NOT NULL CHECK (rate BETWEEN -10 AND 10),
    language TEXT NOT NULL,
    audio_hash TEXT NOT NULL CHECK (length(audio_hash) = 64 AND audio_hash NOT GLOB '*[^0-9a-f]*'),
    cues_hash TEXT NOT NULL CHECK (length(cues_hash) = 64 AND cues_hash NOT GLOB '*[^0-9a-f]*'),
    srt_hash TEXT NOT NULL CHECK (length(srt_hash) = 64 AND srt_hash NOT GLOB '*[^0-9a-f]*'),
    ass_hash TEXT NOT NULL CHECK (length(ass_hash) = 64 AND ass_hash NOT GLOB '*[^0-9a-f]*'),
    deviation_ratio REAL NOT NULL CHECK (deviation_ratio >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, revision),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (snapshot_id, video_id, snapshot_hash)
      REFERENCES video_tts_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE,
    FOREIGN KEY (artifact_id, video_id, snapshot_id, audio_hash, cues_hash, srt_hash, ass_hash)
      REFERENCES video_tts_artifacts(id, video_id, snapshot_id, audio_hash, cues_hash, srt_hash, ass_hash)
  ) STRICT;

  CREATE INDEX video_tts_snapshots_video_created ON video_tts_snapshots(video_id, created_at DESC);
  CREATE INDEX video_tts_cues_video_order ON video_tts_cues(video_id, artifact_id, cue_index);
  CREATE INDEX video_audio_reviews_video_revision ON video_audio_review_events(video_id, revision DESC);

  -- 快照、产物和审核事件是审计事实，只允许随所属视频级联删除。
  CREATE TRIGGER video_tts_snapshots_immutable BEFORE UPDATE ON video_tts_snapshots
  WHEN OLD.id IS NOT NEW.id OR OLD.project_id IS NOT NEW.project_id OR OLD.video_id IS NOT NEW.video_id
    OR OLD.plan_snapshot_id IS NOT NEW.plan_snapshot_id OR OLD.plan_snapshot_hash IS NOT NEW.plan_snapshot_hash
    OR OLD.script_revision_id IS NOT NEW.script_revision_id OR OLD.script_content_hash IS NOT NEW.script_content_hash
    OR OLD.paragraphs_json IS NOT NEW.paragraphs_json OR OLD.provider_id IS NOT NEW.provider_id
    OR OLD.provider_name IS NOT NEW.provider_name OR OLD.provider_kind IS NOT NEW.provider_kind
    OR OLD.protocol IS NOT NEW.protocol OR OLD.base_url IS NOT NEW.base_url OR OLD.model_id IS NOT NEW.model_id
    OR OLD.voice_id IS NOT NEW.voice_id OR OLD.rate IS NOT NEW.rate OR OLD.language IS NOT NEW.language
    OR OLD.params_json IS NOT NEW.params_json OR OLD.target_duration_seconds IS NOT NEW.target_duration_seconds
    OR OLD.system_contract_version IS NOT NEW.system_contract_version OR OLD.canonical_json IS NOT NEW.canonical_json
    OR OLD.snapshot_hash IS NOT NEW.snapshot_hash OR OLD.created_at IS NOT NEW.created_at OR OLD.invalidated_at IS NOT NULL
  BEGIN SELECT RAISE(ABORT, 'video tts snapshot is immutable'); END;
  CREATE TRIGGER video_tts_snapshots_no_delete BEFORE DELETE ON video_tts_snapshots
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video tts snapshot is immutable'); END;
  CREATE TRIGGER video_tts_artifacts_immutable BEFORE UPDATE ON video_tts_artifacts
  BEGIN SELECT RAISE(ABORT, 'video tts artifacts are immutable'); END;
  CREATE TRIGGER video_tts_artifacts_no_delete BEFORE DELETE ON video_tts_artifacts
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video tts artifacts are immutable'); END;
  CREATE TRIGGER video_tts_cues_immutable BEFORE UPDATE ON video_tts_cues
  BEGIN SELECT RAISE(ABORT, 'video tts cues are immutable'); END;
  CREATE TRIGGER video_tts_cues_no_delete BEFORE DELETE ON video_tts_cues
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video tts cues are immutable'); END;
  CREATE TRIGGER video_audio_reviews_immutable BEFORE UPDATE ON video_audio_review_events
  BEGIN SELECT RAISE(ABORT, 'video audio review events are append-only'); END;
  CREATE TRIGGER video_audio_reviews_no_delete BEFORE DELETE ON video_audio_review_events
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video audio review events are append-only'); END;
`;

const MIGRATION_25 = `
  CREATE TABLE videos_v25 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 100),
    status TEXT NOT NULL CHECK (status IN (
      'draft', 'preparing_sources', 'generating_script', 'planning_visuals',
      'awaiting_review', 'producing_media', 'awaiting_media_review', 'rendering',
      'completed', 'failed', 'cancelled'
    )),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    input_mode TEXT NOT NULL DEFAULT 'topic' CHECK (input_mode IN ('topic', 'body')),
    topic TEXT NOT NULL DEFAULT '' CHECK (length(topic) <= 200),
    body TEXT NOT NULL DEFAULT '' CHECK (length(CAST(body AS BLOB)) <= 131072),
    reference_text TEXT NOT NULL DEFAULT '' CHECK (length(CAST(reference_text AS BLOB)) <= 65536),
    reference_role TEXT NOT NULL DEFAULT 'style_only' CHECK (reference_role IN ('style_only', 'content_source')),
    target_duration_seconds INTEGER NOT NULL DEFAULT 180 CHECK (target_duration_seconds BETWEEN 60 AND 600),
    visual_density TEXT NOT NULL DEFAULT 'standard' CHECK (visual_density IN ('relaxed', 'standard', 'compact')),
    web_enabled INTEGER NOT NULL DEFAULT 1 CHECK (web_enabled IN (0, 1)),
    script_instructions TEXT NOT NULL DEFAULT '' CHECK (length(script_instructions) <= 20000),
    visual_instructions TEXT NOT NULL DEFAULT '' CHECK (length(visual_instructions) <= 20000),
    UNIQUE (id, project_id)
  ) STRICT;
  INSERT INTO videos_v25 SELECT * FROM videos;
  DROP TABLE videos;
  ALTER TABLE videos_v25 RENAME TO videos;
  CREATE INDEX videos_project_order ON videos(project_id, updated_at DESC, id);

  CREATE TABLE video_visual_timelines (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
    plan_snapshot_id TEXT NOT NULL,
    plan_snapshot_hash TEXT NOT NULL CHECK (length(plan_snapshot_hash) = 64 AND plan_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    script_revision_id TEXT NOT NULL,
    script_content_hash TEXT NOT NULL CHECK (length(script_content_hash) = 64 AND script_content_hash NOT GLOB '*[^0-9a-f]*'),
    visual_revision_id TEXT NOT NULL,
    visual_content_hash TEXT NOT NULL CHECK (length(visual_content_hash) = 64 AND visual_content_hash NOT GLOB '*[^0-9a-f]*'),
    image_gate_revision INTEGER NOT NULL CHECK (image_gate_revision >= 1),
    tts_snapshot_id TEXT NOT NULL,
    tts_snapshot_hash TEXT NOT NULL CHECK (length(tts_snapshot_hash) = 64 AND tts_snapshot_hash NOT GLOB '*[^0-9a-f]*'),
    tts_artifact_id TEXT NOT NULL,
    audio_hash TEXT NOT NULL CHECK (length(audio_hash) = 64 AND audio_hash NOT GLOB '*[^0-9a-f]*'),
    cues_hash TEXT NOT NULL CHECK (length(cues_hash) = 64 AND cues_hash NOT GLOB '*[^0-9a-f]*'),
    srt_hash TEXT NOT NULL CHECK (length(srt_hash) = 64 AND srt_hash NOT GLOB '*[^0-9a-f]*'),
    ass_hash TEXT NOT NULL CHECK (length(ass_hash) = 64 AND ass_hash NOT GLOB '*[^0-9a-f]*'),
    audio_duration_ms INTEGER NOT NULL CHECK (audio_duration_ms > 0),
    timeline_hash TEXT NOT NULL CHECK (length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, revision),
    UNIQUE (video_id, identity_hash),
    UNIQUE (id, video_id),
    UNIQUE (id, video_id, timeline_hash),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (plan_snapshot_id, video_id, plan_snapshot_hash)
      REFERENCES video_plan_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE,
    FOREIGN KEY (script_revision_id, video_id, plan_snapshot_id, script_content_hash)
      REFERENCES video_script_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE,
    FOREIGN KEY (visual_revision_id, video_id, plan_snapshot_id, visual_content_hash)
      REFERENCES video_visual_revisions(id, video_id, snapshot_id, content_hash) ON DELETE CASCADE,
    FOREIGN KEY (tts_snapshot_id, video_id, tts_snapshot_hash)
      REFERENCES video_tts_snapshots(id, video_id, snapshot_hash) ON DELETE CASCADE,
    FOREIGN KEY (tts_artifact_id, video_id, tts_snapshot_id, audio_hash, cues_hash, srt_hash, ass_hash)
      REFERENCES video_tts_artifacts(id, video_id, snapshot_id, audio_hash, cues_hash, srt_hash, ass_hash)
  ) STRICT;

  CREATE TABLE video_visual_segments (
    id TEXT PRIMARY KEY,
    stable_segment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    timeline_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    segment_index INTEGER NOT NULL CHECK (segment_index >= 0),
    cue_start_index INTEGER NOT NULL CHECK (cue_start_index >= 0),
    cue_end_index INTEGER NOT NULL CHECK (cue_end_index >= cue_start_index),
    cue_start_hash TEXT NOT NULL CHECK (length(cue_start_hash) = 64 AND cue_start_hash NOT GLOB '*[^0-9a-f]*'),
    cue_end_hash TEXT NOT NULL CHECK (length(cue_end_hash) = 64 AND cue_end_hash NOT GLOB '*[^0-9a-f]*'),
    start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
    end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
    visual_id TEXT NOT NULL CHECK (length(visual_id) > 0),
    candidate_id TEXT NOT NULL,
    candidate_hash TEXT NOT NULL CHECK (length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'),
    candidate_relative_path TEXT NOT NULL CHECK (length(candidate_relative_path) > 0),
    motion_kind TEXT NOT NULL CHECK (motion_kind IN ('still','zoom_in','zoom_out','pan_left','pan_right')),
    motion_amount_ppm INTEGER NOT NULL CHECK (motion_amount_ppm BETWEEN 0 AND 500000),
    fade_in_ms INTEGER NOT NULL CHECK (fade_in_ms BETWEEN 0 AND 5000),
    fade_out_ms INTEGER NOT NULL CHECK (fade_out_ms BETWEEN 0 AND 5000),
    segment_hash TEXT NOT NULL CHECK (length(segment_hash) = 64 AND segment_hash NOT GLOB '*[^0-9a-f]*'),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (timeline_id, segment_index),
    UNIQUE (timeline_id, stable_segment_id),
    UNIQUE (timeline_id, segment_hash),
    UNIQUE (id, video_id, timeline_id, segment_hash),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (timeline_id, video_id) REFERENCES video_visual_timelines(id, video_id) ON DELETE CASCADE,
    FOREIGN KEY (candidate_id, project_id, video_id, visual_id, candidate_hash)
      REFERENCES video_image_candidates(id, project_id, video_id, visual_id, file_hash)
  ) STRICT;

  CREATE TABLE video_visual_review_events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    timeline_id TEXT NOT NULL,
    timeline_revision INTEGER NOT NULL CHECK (timeline_revision >= 1),
    timeline_hash TEXT NOT NULL CHECK (length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'),
    identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
    action TEXT NOT NULL CHECK (action IN ('approve','needs_changes')),
    notes TEXT NOT NULL CHECK (length(notes) <= 10000),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (video_id, revision),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (timeline_id, video_id, timeline_hash)
      REFERENCES video_visual_timelines(id, video_id, timeline_hash) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE video_render_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    timeline_id TEXT NOT NULL,
    timeline_hash TEXT NOT NULL CHECK (length(timeline_hash) = 64 AND timeline_hash NOT GLOB '*[^0-9a-f]*'),
    visual_review_id TEXT NOT NULL REFERENCES video_visual_review_events(id) ON DELETE RESTRICT,
    identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
    job_id TEXT REFERENCES jobs(id) ON DELETE RESTRICT,
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    params_json TEXT NOT NULL CHECK (json_valid(params_json)),
    params_hash TEXT NOT NULL CHECK (length(params_hash) = 64 AND params_hash NOT GLOB '*[^0-9a-f]*'),
    error_summary TEXT,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (video_id, identity_hash),
    UNIQUE (id, video_id),
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (timeline_id, video_id, timeline_hash)
      REFERENCES video_visual_timelines(id, video_id, timeline_hash) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE video_render_chunks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    timeline_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
    segment_id TEXT NOT NULL,
    segment_hash TEXT NOT NULL CHECK (length(segment_hash) = 64 AND segment_hash NOT GLOB '*[^0-9a-f]*'),
    identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
    relative_path TEXT,
    bytes INTEGER CHECK (bytes IS NULL OR bytes > 0),
    file_hash TEXT CHECK (file_hash IS NULL OR (length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*')),
    media_info_json TEXT CHECK (media_info_json IS NULL OR json_valid(media_info_json)),
    error_summary TEXT,
    checkpoint_at INTEGER CHECK (checkpoint_at IS NULL OR checkpoint_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
    UNIQUE (run_id, chunk_index),
    UNIQUE (run_id, identity_hash),
    FOREIGN KEY (run_id, video_id) REFERENCES video_render_runs(id, video_id) ON DELETE CASCADE,
    FOREIGN KEY (segment_id, video_id, timeline_id, segment_hash)
      REFERENCES video_visual_segments(id, video_id, timeline_id, segment_hash)
  ) STRICT;

  CREATE TABLE video_final_videos (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    video_id TEXT NOT NULL,
    identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64 AND identity_hash NOT GLOB '*[^0-9a-f]*'),
    relative_path TEXT NOT NULL CHECK (length(relative_path) > 0),
    bytes INTEGER NOT NULL CHECK (bytes > 0),
    file_hash TEXT NOT NULL CHECK (length(file_hash) = 64 AND file_hash NOT GLOB '*[^0-9a-f]*'),
    media_info_json TEXT NOT NULL CHECK (json_valid(media_info_json)),
    manifest_relative_path TEXT NOT NULL CHECK (length(manifest_relative_path) > 0),
    manifest_bytes INTEGER NOT NULL CHECK (manifest_bytes > 0),
    manifest_hash TEXT NOT NULL CHECK (length(manifest_hash) = 64 AND manifest_hash NOT GLOB '*[^0-9a-f]*'),
    ffmpeg_version TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (run_id),
    UNIQUE (video_id, identity_hash),
    FOREIGN KEY (run_id, video_id) REFERENCES video_render_runs(id, video_id) ON DELETE CASCADE,
    FOREIGN KEY (video_id, project_id) REFERENCES videos(id, project_id) ON DELETE CASCADE
  ) STRICT;

  CREATE INDEX video_visual_timelines_current ON video_visual_timelines(video_id, revision DESC);
  CREATE INDEX video_visual_segments_order ON video_visual_segments(timeline_id, segment_index);
  CREATE INDEX video_visual_reviews_current ON video_visual_review_events(video_id, revision DESC);
  CREATE INDEX video_render_runs_current ON video_render_runs(video_id, created_at DESC);
  CREATE INDEX video_render_chunks_status ON video_render_chunks(run_id, status, chunk_index);

  CREATE TRIGGER video_visual_timelines_immutable BEFORE UPDATE ON video_visual_timelines
  BEGIN SELECT RAISE(ABORT, 'video visual timelines are immutable'); END;
  CREATE TRIGGER video_visual_timelines_no_delete BEFORE DELETE ON video_visual_timelines
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video visual timelines are immutable'); END;
  CREATE TRIGGER video_visual_segments_immutable BEFORE UPDATE ON video_visual_segments
  BEGIN SELECT RAISE(ABORT, 'video visual segments are immutable'); END;
  CREATE TRIGGER video_visual_segments_no_delete BEFORE DELETE ON video_visual_segments
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video visual segments are immutable'); END;
  CREATE TRIGGER video_visual_reviews_immutable BEFORE UPDATE ON video_visual_review_events
  BEGIN SELECT RAISE(ABORT, 'video visual review events are append-only'); END;
  CREATE TRIGGER video_visual_reviews_no_delete BEFORE DELETE ON video_visual_review_events
  WHEN EXISTS (SELECT 1 FROM videos WHERE id = OLD.video_id)
  BEGIN SELECT RAISE(ABORT, 'video visual review events are append-only'); END;
`;

const MIGRATIONS = [
  MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8,
  MIGRATION_9,
  MIGRATION_10,
  MIGRATION_11,
  MIGRATION_12,
  MIGRATION_13,
  MIGRATION_14,
  MIGRATION_15,
  MIGRATION_16,
  MIGRATION_17,
  MIGRATION_18,
  MIGRATION_19,
  MIGRATION_20,
  MIGRATION_21,
  MIGRATION_22,
  MIGRATION_23,
  MIGRATION_24,
  MIGRATION_25,
];

export interface YingshuDatabase {
  database: DatabaseSync;
  path: string;
  close(): void;
}

export function openDatabase(dataRoot?: string): YingshuDatabase {
  const root = resolveDataRoot(dataRoot);
  mkdirSync(root, { recursive: true });

  const path = join(root, "yingshu.sqlite3");
  const database = new DatabaseSync(path);

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) STRICT;
    `);

    const applied = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    if (applied.length > MIGRATIONS.length ||
        applied.some((migration, index) => migration.version !== index + 1)) {
      throw new Error("数据库迁移版本不兼容");
    }

    for (let index = applied.length; index < MIGRATIONS.length; index += 1) {
      const rebuildsReferencedTable = index === 12 || index === 22 || index === 24;
      const videoDeleteTriggers = index === 24 ? database.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%FROM videos%' ORDER BY name",
      ).all() as Array<{ name: string; sql: string }> : [];
      if (rebuildsReferencedTable) database.exec("PRAGMA foreign_keys = OFF");
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const trigger of videoDeleteTriggers) {
          database.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
        }
        database.exec(MIGRATIONS[index]!);
        for (const trigger of videoDeleteTriggers) database.exec(trigger.sql);
        if (rebuildsReferencedTable && database.prepare("PRAGMA foreign_key_check").all().length) {
          throw new Error("数据库迁移后外键校验失败");
        }
        database.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(index + 1);
        database.exec("COMMIT");
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // 保留原始迁移错误；外层仍会关闭连接。
        }
        throw error;
      } finally {
        if (rebuildsReferencedTable) database.exec("PRAGMA foreign_keys = ON");
      }
    }

    return {
      database,
      path,
      close: () => database.close(),
    };
  } catch (error) {
    try {
      database.close();
    } catch {
      // 抛出导致初始化失败的原始错误。
    }
    throw error;
  }
}
